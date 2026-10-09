// The readiness eval: does a captured reason actually change how Claude routes the decisions it
// should, and leave the others alone? Three fresh live calls per condition (no cache, no recorded
// answers), each checked against an expected outcome written down before running.
//
//   npm run eval              # live; uses the keychain item "anthropic-api-key"; about $0.60
//
// These are designed demonstration checks on fixtures written for the demo, not an accuracy
// estimate. Raw outputs go to results/captures/eval-<timestamp>.json; the summary prints per condition.

import Anthropic from "@anthropic-ai/sdk";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { EFFORT, MAX_TOKENS, MODEL, PRICE_PER_MTOK } from "../src/shared/constants";
import { EXAMPLES } from "../src/shared/examples";
import { parseFactOutput } from "../src/shared/fact";
import { keptFact, topGuess, withFact } from "../src/shared/lifecycle";
import { FACT_SCHEMA, ROUTE_SCHEMA, factPrompt, routePrompt } from "../src/shared/prompts";
import { enforceSettleInvariant, parseRouteOutput, verifiedQuotes } from "../src/shared/route";
import type { Decision, Fact, Persona, RouteOutput, Rule } from "../src/shared/types";

/** Fresh calls per condition. Three, so one lucky or unlucky sample does not decide a result. */
const TRIALS = 3;
/** Hard ceiling on one eval run's spend, in dollars. */
const LOCAL_BUDGET_USD = 3;

const read = <T>(p: string): T => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8")) as T;
const persona = read<Persona>("fixtures/persona.json");
const rules = read<Rule[]>("fixtures/rules.json");
const facts = read<Fact[]>("fixtures/facts.json");
const decisions = read<Decision[]>("fixtures/decisions.json");
const byId = new Map(decisions.map((d) => [d.id, d]));

const keychainOrEnv = process.env.ANTHROPIC_API_KEY || execFileSync("security", ["find-generic-password", "-a", process.env.USER ?? "", "-s", "anthropic-api-key", "-w"], { encoding: "utf8" }).trim();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || keychainOrEnv, maxRetries: 2 });
let spent = 0;
const raw: unknown[] = [];

async function call(label: string, prompt: string, schema: object): Promise<unknown> {
  if (spent > LOCAL_BUDGET_USD) throw new Error(`local budget of $${LOCAL_BUDGET_USD} spent`);
  const t0 = Date.now();
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    output_config: { effort: EFFORT, format: { type: "json_schema", schema: schema as Record<string, unknown> } },
    messages: [{ role: "user", content: prompt }],
  });
  const cost = (msg.usage.input_tokens * PRICE_PER_MTOK.input + msg.usage.output_tokens * PRICE_PER_MTOK.output) / 1e6;
  spent += cost;
  const text = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
  const out = JSON.parse(text);
  raw.push({ label, ms: Date.now() - t0, cost, stop_reason: msg.stop_reason, out });
  return out;
}

interface Check {
  name: string;
  /** What must be true of a routed card for this trial to pass. Written before running. */
  expect: string;
  run: () => Promise<{ pass: boolean; detail: string }>;
}

async function route(id: string, f: Fact[]): Promise<{ out: RouteOutput; route: string }> {
  const d = byId.get(id)!;
  const out = parseRouteOutput(await call(`route ${id}`, routePrompt(persona, rules, f, d), ROUTE_SCHEMA), d);
  return { out, route: enforceSettleInvariant(out, d, rules).route };
}

/** The facts after keeping the guidance from an example's reason, and the kept fact's text ("" if none). */
async function factAfter(exId: string, reason?: string): Promise<{ facts: Fact[]; added: string }> {
  const ex = EXAMPLES.find((e) => e.id === exId)!;
  const d = byId.get(exId)!;
  const others = decisions.filter((x) => x.id !== exId);
  const fo = parseFactOutput(await call(`fact ${exId}`, factPrompt(persona, rules, facts, d, ex.choice, reason ?? ex.reason, others), FACT_SCHEMA), facts);
  if (fo.kind === "none") return { facts, added: "" };
  const kept = keptFact(facts, fo, fo.text, d.options.find((o) => o.key === ex.choice)!.label);
  return { facts: withFact(facts, kept), added: kept.text };
}

const describe = (r: { out: RouteOutput; route: string }) => {
  const t = topGuess(r.out.guess);
  return `${r.route} guess ${t.option}@${t.p.toFixed(2)} fact="${r.out.fact_quoted.slice(0, 50)}"`;
};

const checks: Check[] = [
  {
    name: "berlin-sync, default facts",
    expect: "settled (route settle after the code invariant)",
    run: async () => {
      const r = await route("berlin-sync", facts);
      return { pass: r.route === "settle", detail: describe(r) };
    },
  },
  {
    name: "berlin-sync, after the flight reason (recorded wording)",
    expect: "not settled; guess favors declining (B); quotes the newly kept fact",
    run: async () => {
      const { facts: f, added } = await factAfter("onsite-flight");
      const r = await route("berlin-sync", f);
      const q = verifiedQuotes(r.out, rules, f);
      return { pass: Boolean(added) && r.route !== "settle" && topGuess(r.out.guess).option === "B" && q.fact_quoted === added, detail: describe(r) };
    },
  },
  {
    name: "berlin-sync, after a paraphrased flight reason (whole loop)",
    expect: "fact proposed; berlin-sync not settled; guess favors B",
    run: async () => {
      const { facts: f, added } = await factAfter("onsite-flight", "No dawn flights for me. I'm on the school run until half past eight.");
      const r = await route("berlin-sync", f);
      return { pass: Boolean(added) && r.route !== "settle" && topGuess(r.out.guess).option === "B", detail: describe(r) };
    },
  },
  {
    name: "formatter-run (control), after the flight reason",
    expect: "still settled",
    run: async () => {
      const { facts: f } = await factAfter("onsite-flight");
      const r = await route("formatter-run", f);
      return { pass: r.route === "settle", detail: describe(r) };
    },
  },
  {
    name: "webhook-rename, default facts",
    expect: "a decision for Jordan (public API rule)",
    run: async () => {
      const r = await route("webhook-rename", facts);
      return { pass: r.route === "decide", detail: describe(r) };
    },
  },
  {
    name: "webhook-rename, after the API rename reason",
    expect: "a decision; guess favors keeping the name (B) at >= 0.6; quotes the newly kept fact",
    run: async () => {
      const { facts: f, added } = await factAfter("api-rename");
      const r = await route("webhook-rename", f);
      const t = topGuess(r.out.guess);
      const q = verifiedQuotes(r.out, rules, f);
      return { pass: Boolean(added) && r.route === "decide" && t.option === "B" && t.p >= 0.6 && q.fact_quoted === added, detail: describe(r) };
    },
  },
  {
    name: "free-tier (control), after the API rename reason",
    expect: "still a decision; does not quote the new fact",
    run: async () => {
      const { facts: f, added } = await factAfter("api-rename");
      const r = await route("free-tier", f);
      const q = verifiedQuotes(r.out, rules, f);
      return { pass: r.route === "decide" && (!added || q.fact_quoted !== added), detail: describe(r) };
    },
  },
];

async function main(): Promise<void> {
  const summary: { name: string; expect: string; passed: number; trials: number; details: string[] }[] = [];
  for (const c of checks) {
    const details: string[] = [];
    let passed = 0;
    for (let i = 0; i < TRIALS; i++) {
      try {
        const r = await c.run();
        if (r.pass) passed++;
        details.push(`${r.pass ? "pass" : "FAIL"}: ${r.detail}`);
      } catch (e) {
        details.push(`ERROR: ${(e as Error).message}`);
      }
    }
    summary.push({ name: c.name, expect: c.expect, passed, trials: TRIALS, details });
    console.log(`${passed}/${TRIALS}  ${c.name}  (expect: ${c.expect})`);
    for (const d of details) console.log(`        ${d}`);
  }
  mkdirSync(new URL("../results/captures/", import.meta.url), { recursive: true });
  const file = new URL(`../results/captures/eval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, import.meta.url);
  writeFileSync(file, `${JSON.stringify({ model: MODEL, effort: EFFORT, trials: TRIALS, spent_usd: spent, summary, raw }, null, 2)}\n`);
  console.log(`spent $${spent.toFixed(3)}; wrote ${file.pathname}`);
  // The canonical path is a before-and-after change: Berlin settled under the default facts, then not
  // settled (and framed by the new fact) after the flight reason. Both halves must hold every time.
  const [before, after] = summary;
  if (before.passed < TRIALS || after.passed < TRIALS) {
    console.error("the canonical flight path (before and after the reason) did not behave as designed in every trial");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
