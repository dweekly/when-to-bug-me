// Record live Claude answers for the requests a fresh visit makes, so the default morning and the
// canonical example cost nothing to serve and still show real model output (labeled "recorded").
//
//   npm run record              # uses the API key in the macOS keychain item "anthropic-api-key"
//   npm run record -- --dry-run # prints what it would call and the cost ceiling, calls nothing
//
// It records: the route of every decision under the default rules and facts; then, for each
// canonical example below, the fact call for its scripted reason and the re-route of every decision
// that answer would re-check. Requests are built with the same functions the Worker uses, and keyed
// with the same modelCacheKey, so the Worker replays an entry only for a byte-identical request.
// It stops when its own spend passes LOCAL_BUDGET_USD.

import Anthropic from "@anthropic-ai/sdk";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { EFFORT, MAX_REROUTES_PER_FACT, MAX_TOKENS, MODEL, PRICE_PER_MTOK } from "../src/shared/constants";
import { parseFactOutput } from "../src/shared/fact";
import { modelCacheKey } from "../src/shared/hash";
import { keptFact, withFact } from "../src/shared/lifecycle";
import { FACT_SCHEMA, PROMPT_VERSION, ROUTE_SCHEMA, factPrompt, routePrompt } from "../src/shared/prompts";
import { parseRouteOutput } from "../src/shared/route";
import type { Decision, Fact, Persona, Rule } from "../src/shared/types";
import { EXAMPLES } from "../src/shared/examples";

/** Hard ceiling on what one recording run may spend, in dollars. About 60 low-effort calls fit well under it. */
const LOCAL_BUDGET_USD = 4;
/** Concurrent requests. Small, to stay polite to rate limits. */
const CONCURRENCY = 4;

const read = <T>(p: string): T => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8")) as T;
const persona = read<Persona>("fixtures/persona.json");
const rules = read<Rule[]>("fixtures/rules.json");
const facts = read<Fact[]>("fixtures/facts.json");
const decisions = read<Decision[]>("fixtures/decisions.json");
const byId = new Map(decisions.map((d) => [d.id, d]));
const OUT = new URL("../fixtures/captures/recorded.json", import.meta.url);
const dryRun = process.argv.includes("--dry-run");

const recorded = JSON.parse(readFileSync(OUT, "utf8")) as { note: string; entries: Record<string, unknown> };
let spent = 0;
let calls = 0;

function keychain(service: string): string {
  return execFileSync("security", ["find-generic-password", "-a", process.env.USER ?? "", "-s", service, "-w"], { encoding: "utf8" }).trim();
}

const client = dryRun ? null : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || keychain("anthropic-api-key"), maxRetries: 2 });

/** Ask, validating with `validate` before anything is recorded, so a bad answer is never saved. */
async function ask(label: string, prompt: string, schema: object, validate: (raw: unknown) => unknown): Promise<unknown> {
  const key = await modelCacheKey({ model: MODEL, effort: EFFORT, maxTokens: MAX_TOKENS, promptVersion: PROMPT_VERSION, schema, prompt });
  const have = recorded.entries[key] as { output: unknown } | undefined;
  if (have) return have.output;
  if (dryRun || !client) {
    calls++;
    console.log(`would call: ${label}`);
    return null;
  }
  if (spent > LOCAL_BUDGET_USD) throw new Error(`local budget of $${LOCAL_BUDGET_USD} spent`);
  const t0 = Date.now();
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    output_config: { effort: EFFORT, format: { type: "json_schema", schema: schema as Record<string, unknown> } },
    messages: [{ role: "user", content: prompt }],
  });
  const u = msg.usage;
  const cost = (u.input_tokens * PRICE_PER_MTOK.input + u.output_tokens * PRICE_PER_MTOK.output) / 1e6;
  spent += cost;
  calls++;
  if (msg.stop_reason !== "end_turn") throw new Error(`${label}: stop_reason ${msg.stop_reason}`);
  const text = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
  const output = JSON.parse(text);
  validate(output); // throws on a semantically invalid answer; nothing is recorded and a rerun retries
  recorded.entries[key] = { label, output, model: MODEL, recorded_at: new Date().toISOString(), usage: { input: u.input_tokens, output: u.output_tokens }, ms: Date.now() - t0 };
  console.log(`${label}: $${cost.toFixed(4)} in ${Date.now() - t0} ms (total $${spent.toFixed(3)})`);
  return output;
}

async function pool<T>(items: T[], fn: (t: T) => Promise<void>): Promise<void> {
  const q = [...items];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (q.length) await fn(q.shift()!);
  }));
}

async function routeAll(ids: string[], r: Rule[], f: Fact[], tag: string): Promise<void> {
  await pool(ids, async (id) => {
    const d = byId.get(id)!;
    const out = await ask(`route ${id} [${tag}]`, routePrompt(persona, r, f, d), ROUTE_SCHEMA, (raw) => parseRouteOutput(raw, d));
    if (out) {
      const p = parseRouteOutput(out, d);
      const top = p.guess.reduce((a, b) => (b.p > a.p ? b : a));
      console.log(`  ${id}: ${p.route}${p.settle_option ? `(${p.settle_option})` : ""} guess ${top.option}@${top.p.toFixed(2)} problem=${p.problem}${p.conflicts.length ? ` conflicts=${p.conflicts.map((c) => c.option).join(",")}` : ""}`);
    }
  });
}

async function main(): Promise<void> {
  await routeAll(decisions.map((d) => d.id), rules, facts, "default");
  for (const ex of EXAMPLES) {
    const d = byId.get(ex.id)!;
    const others = decisions.filter((x) => x.id !== d.id);
    const raw = await ask(`fact ${ex.id}`, factPrompt(persona, rules, facts, d, ex.choice, ex.reason, others), FACT_SCHEMA, (x) => parseFactOutput(x, facts));
    if (!raw) continue;
    const fo = parseFactOutput(raw, facts);
    console.log(`  fact ${ex.id}: ${fo.kind} "${fo.text}" may_affect=${fo.may_affect.join(",")}`);
    if (fo.kind === "none") continue;
    // The same candidate set the Worker computes for a fresh morning: tag overlap plus suggestions, capped.
    const known = new Set(others.map((o) => o.id));
    const byTag = others.filter((w) => w.tags.some((t) => d.tags.includes(t))).map((w) => w.id);
    const reroute = [...new Set([...fo.may_affect.filter((x) => known.has(x)), ...byTag])].slice(0, MAX_REROUTES_PER_FACT);
    const label = d.options.find((o) => o.key === ex.choice)!.label;
    const f2 = withFact(facts, keptFact(facts, fo, fo.text, label));
    await routeAll(reroute, rules, f2, `after ${ex.id}`);
  }
  writeFileSync(OUT, `${JSON.stringify(recorded, null, 2)}\n`);
  console.log(`${dryRun ? "would make" : "made"} ${calls} call(s); spent $${spent.toFixed(3)}; ${Object.keys(recorded.entries).length} entries recorded`);
}

main().catch((e) => {
  writeFileSync(OUT, `${JSON.stringify(recorded, null, 2)}\n`);
  console.error(e);
  process.exit(1);
});
