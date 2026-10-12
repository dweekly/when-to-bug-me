// Record live Claude answers for the requests a fresh visit makes, so the default morning and the
// canonical example cost nothing to serve and still show real model output (labeled "recorded").
//
//   npm run record              # uses the API key in the macOS keychain item "anthropic-api-key"
//   npm run record -- --dry-run # prints what it would call and the cost ceiling, calls nothing
//
// It records: the route of every decision under the default rules and facts; then, for each
// canonical example, the parse of Jordan's narration, the question each "ask" mark sends, the fact call
// for the reason and conditions the page derives from that parse (or the scripted "why?" reason when
// the narration gives none), and the re-route of every decision that answer would re-check. Requests are built with the same functions the Worker uses, and keyed
// with the same modelCacheKey, so the Worker replays an entry only for a byte-identical request.
//
// Stage 6 adds: every decision's emoji and title (the fast model), and each tour decision's scripted
// conversation (CONVERSATIONS), played turn by turn against live Claude. Each turn advances on the reply
// as the browser receives it (checked and put through `advance`); the run fails when Bug Me does
// something other than the script expects. The guidance call the confirmed thread leads to, and its
// re-routes, are recorded too. Entries already recorded are re-checked against today's validators; a
// stale one is dropped and asked again.
// It stops when its own spend passes LOCAL_BUDGET_USD.

import Anthropic from "@anthropic-ai/sdk";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { EFFORT, MAX_REROUTES_PER_FACT, MAX_TOKENS, MODEL, PRICE_PER_MTOK, TITLE_MAX_TOKENS, TITLE_MODEL, TITLE_PRICE_PER_MTOK } from "../src/shared/constants";
import { type ConvTurn, type ConverseResult, type Next, advance, closeInputs, outcomeOf, sanitizeLedger } from "../src/shared/converse";
import { parseTitles } from "../src/shared/titles";
import { parseFactOutput } from "../src/shared/fact";
import { modelCacheKey } from "../src/shared/hash";
import { keptFact, withFact } from "../src/shared/lifecycle";
import {
  ASK_SCHEMA,
  CONVERSE_PROMPT_VERSION,
  FACT_SCHEMA,
  PARSE_PROMPT_VERSION,
  PROMPT_VERSION,
  TITLE_PROMPT_VERSION,
  askPrompt,
  conversePrompt,
  converseSchema,
  factPrompt,
  parsePrompt,
  parseSchema,
  routePrompt,
  routeSchema,
  titlePrompt,
  titleSchema,
} from "../src/shared/prompts";
import { parseAskOutput } from "../src/shared/ask";
import { answerParts, guidanceText, parseParseOutput } from "../src/shared/parse";
import { MAX_REASON_CHARS } from "../src/shared/constants";
import { enforceSettleInvariant, parseRouteOutput } from "../src/shared/route";
import type { Decision, Fact, Persona, Rule } from "../src/shared/types";
import { CONVERSATIONS, EXAMPLES } from "../src/shared/examples";

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
/** Calls whose answer failed validation: reported, not recorded, and the run exits non-zero. */
const rejected: string[] = [];

function keychain(service: string): string {
  return execFileSync("security", ["find-generic-password", "-a", process.env.USER ?? "", "-s", service, "-w"], { encoding: "utf8" }).trim();
}

const client = dryRun ? null : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || keychain("anthropic-api-key"), maxRetries: 2 });

/** The model a call uses: the main one, or the fast one for titles (as in src/worker/model.ts). */
const MAIN = { model: MODEL, maxTokens: MAX_TOKENS, price: PRICE_PER_MTOK };
const FAST = { model: TITLE_MODEL, maxTokens: TITLE_MAX_TOKENS, price: TITLE_PRICE_PER_MTOK };

/** Ask, validating with `validate` before anything is recorded, so a bad answer is never saved. An
 *  entry already recorded is re-checked the same way; one that fails today's checks is asked again. */
async function ask(label: string, prompt: string, schema: object, validate: (raw: unknown) => unknown, promptVersion = PROMPT_VERSION, m = MAIN): Promise<unknown> {
  const key = await modelCacheKey({ model: m.model, effort: EFFORT, maxTokens: m.maxTokens, promptVersion, schema, prompt });
  const have = recorded.entries[key] as { output: unknown } | undefined;
  if (have) {
    try {
      validate(have.output);
      return have.output;
    } catch (e) {
      console.warn(`${label}: recorded answer fails today's checks (${(e as Error).message}); asking again`);
      delete recorded.entries[key];
    }
  }
  if (dryRun || !client) {
    calls++;
    console.log(`would call: ${label}`);
    return null;
  }
  if (spent > LOCAL_BUDGET_USD) throw new Error(`local budget of $${LOCAL_BUDGET_USD} spent`);
  const t0 = Date.now();
  const msg = await client.messages.create({
    model: m.model,
    max_tokens: m.maxTokens,
    output_config: { effort: EFFORT, format: { type: "json_schema", schema: schema as Record<string, unknown> } },
    messages: [{ role: "user", content: prompt }],
  });
  const u = msg.usage;
  const cost = (u.input_tokens * m.price.input + u.output_tokens * m.price.output) / 1e6;
  spent += cost;
  calls++;
  if (msg.stop_reason !== "end_turn") throw new Error(`${label}: stop_reason ${msg.stop_reason}`);
  const text = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
  const output = JSON.parse(text);
  try {
    validate(output); // throws on a semantically invalid answer; nothing is recorded and a rerun retries
  } catch (e) {
    rejected.push(label);
    console.error(`${label}: REJECTED (${(e as Error).message}); not recorded. The model returned:\n${JSON.stringify(output, null, 2)}`);
    return null;
  }
  recorded.entries[key] = { label, output, model: m.model, recorded_at: new Date().toISOString(), usage: { input: u.input_tokens, output: u.output_tokens }, ms: Date.now() - t0 };
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
    const out = await ask(`route ${id} [${tag}]`, routePrompt(persona, r, f, d), routeSchema(d.options.map((o) => o.key)), (raw) => parseRouteOutput(raw, d));
    if (out) {
      const p = parseRouteOutput(out, d);
      const top = p.guess.reduce((a, b) => (b.p > a.p ? b : a));
      console.log(`  ${id}: ${p.route}${p.settle_option ? `(${p.settle_option})` : ""} guess ${top.option}@${top.p.toFixed(2)} problem=${p.problem}${p.conflicts.length ? ` conflicts=${p.conflicts.map((c) => c.option).join(",")}` : ""}`);
    }
  });
}

/** Every decision's emoji, title and "done" lines, from the fast model. */
async function titlesAll(): Promise<void> {
  await pool(decisions, async (d) => {
    const out = await ask(`titles ${d.id}`, titlePrompt(d), titleSchema(d.options.map((o) => o.key)), (raw) => parseTitles(raw, d), TITLE_PROMPT_VERSION, FAST);
    if (out) {
      const t = parseTitles(out, d);
      console.log(`  ${d.id}: ${t.emoji} ${t.title} | ${Object.values(t.done).join(" | ")}`);
    }
  });
}

/** Recorded routes give each conversation the card the page would show (its route and reason). */
async function routedCard(d: Decision): Promise<{ route: "settle" | "check_in" | "decide"; why_here: string }> {
  const raw = await ask(`route ${d.id} [default]`, routePrompt(persona, rules, facts, d), routeSchema(d.options.map((o) => o.key)), (x) => parseRouteOutput(x, d));
  const out = parseRouteOutput(raw, d);
  return { route: enforceSettleInvariant(out, d, rules, facts).route, why_here: out.why_here };
}

/** Play one scripted conversation, then record the guidance call it leads to and that call's re-routes. */
async function playConversation(s: (typeof CONVERSATIONS)[number]): Promise<void> {
  const d = byId.get(s.id)!;
  const card = await routedCard(d);
  const turns: ConvTurn[] = [];
  let last: ConverseResult | null = null;
  for (const [i, t] of s.turns.entries()) {
    turns.push(t.pick ? { who: "jordan", text: t.text, pick: t.pick } : { who: "jordan", text: t.text });
    const at = [...turns];
    const finish = (raw: unknown): ConverseResult => {
      const o = raw as { reply: string; next: Next; ledger: unknown };
      return advance(d, at, o.reply, o.next, sanitizeLedger(o.ledger, d, at));
    };
    const raw = await ask(`converse ${s.id} [turn ${i}]`, conversePrompt(persona, rules, facts, d, card, at), converseSchema(d.options.map((o) => o.key)), finish, CONVERSE_PROMPT_VERSION);
    if (!raw) return;
    last = finish(raw);
    console.log(`  converse ${s.id} [turn ${i}]: ${last.next}${last.forced ? ` (forced: ${last.forced})` : ""} "${last.reply}"`);
    if (last.next !== s.expect[i]) mismatched.push(`converse ${s.id} turn ${i}: ${last.next}, the script expects ${s.expect[i]}`);
    turns.push({ who: "bugme", text: last.reply, next: last.next });
  }
  if (!last) return;
  const c = closeInputs(d, turns, last.ledger);
  const o = outcomeOf(d, last.ledger);
  if (o.kind !== "option" || o.key !== s.choice) {
    mismatched.push(`converse ${s.id}: resolves to ${JSON.stringify(o)}, the script expects ${s.choice}`);
    return;
  }
  console.log(`  close ${s.id}: reason "${c.reason}" conditions "${c.conditions}" evidence "${c.evidence}"`);
  if (c.evidence) await factAndReroutes(d, s.choice, c.evidence);
}

/** Calls that ran but did something other than a script expects: the run exits non-zero. */
const mismatched: string[] = [];

async function factAndReroutes(d: Decision, choice: string, evidence: string): Promise<void> {
  const others = decisions.filter((x) => x.id !== d.id);
  const raw = await ask(`fact ${d.id}`, factPrompt(persona, rules, facts, d, choice, evidence, others), FACT_SCHEMA, (x) => parseFactOutput(x, facts));
  if (!raw) return;
  const fo = parseFactOutput(raw, facts);
  console.log(`  fact ${d.id}: ${fo.kind} "${fo.text}" may_affect=${fo.may_affect.join(",")}`);
  if (fo.kind === "none") return;
  // The same candidate set the Worker computes for a fresh morning: tag overlap plus suggestions, capped.
  const known = new Set(others.map((o) => o.id));
  const byTag = others.filter((w) => w.tags.some((t) => d.tags.includes(t))).map((w) => w.id);
  const reroute = [...new Set([...fo.may_affect.filter((x) => known.has(x)), ...byTag])].slice(0, MAX_REROUTES_PER_FACT);
  const label = d.options.find((o) => o.key === choice)!.label;
  const f2 = withFact(facts, keptFact(facts, fo, fo.text, label));
  await routeAll(reroute, rules, f2, `after ${d.id}`);
}

async function main(): Promise<void> {
  await routeAll(decisions.map((d) => d.id), rules, facts, "default");
  await titlesAll();
  for (const s of CONVERSATIONS) await playConversation(s);
  for (const ex of EXAMPLES) {
    const d = byId.get(ex.id)!;
    const others = decisions.filter((x) => x.id !== d.id);
    // The narration as the page sends it (the think box, trimmed), and what the page derives from its parse.
    const text = ex.narration.trim();
    const parsedRaw = await ask(`parse ${ex.id}`, parsePrompt(persona, d, text), parseSchema(d.options.map((o) => o.key)), (x) => parseParseOutput(x, d, text), PARSE_PROMPT_VERSION);
    if (!parsedRaw) continue;
    const parsed = parseParseOutput(parsedRaw, d, text);
    console.log(`  parse ${ex.id}: ${parsed.choice} ${parsed.marks.map((m) => `${m.kind}:"${m.quote}"`).join(" ")}`);
    if (parsed.choice !== ex.choice) console.warn(`  parse ${ex.id}: chose ${parsed.choice}, the tour expects ${ex.choice}`);
    for (const m of parsed.marks.filter((x) => x.kind === "ask")) {
      await ask(`ask ${ex.id}`, askPrompt(persona, d, m.quote.slice(0, MAX_REASON_CHARS)), ASK_SCHEMA, parseAskOutput);
    }
    // Two ways the page reaches guidance with Jordan's words: the narration's reason and conditions,
    // or (after a bare click, or a narration with no reason) the scripted reason typed at "why?".
    for (const evidence of [...new Set([guidanceText(answerParts(parsed.marks)), ex.reason].filter(Boolean))]) {
      const raw = await ask(`fact ${ex.id}`, factPrompt(persona, rules, facts, d, ex.choice, evidence, others), FACT_SCHEMA, (x) => parseFactOutput(x, facts));
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
  }
  writeFileSync(OUT, `${JSON.stringify(recorded, null, 2)}\n`);
  console.log(`${dryRun ? "would make" : "made"} ${calls} call(s); spent $${spent.toFixed(3)}; ${Object.keys(recorded.entries).length} entries recorded`);
  if (mismatched.length) {
    console.error(`${mismatched.length} conversation step(s) did not follow the script:\n  ${mismatched.join("\n  ")}`);
    process.exit(1);
  }
  if (rejected.length) {
    console.error(`${rejected.length} answer(s) failed validation and were not recorded: ${rejected.join("; ")}. Rerun to retry them.`);
    process.exit(1);
  }
}

main().catch((e) => {
  writeFileSync(OUT, `${JSON.stringify(recorded, null, 2)}\n`);
  console.error(e);
  process.exit(1);
});
