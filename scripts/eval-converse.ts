// The conversation eval (docs/STAGE-6.md): does Bug Me, talking a decision through with Jordan, ask
// once when it should, stop when it should, answer from the agent's material, hear a rejection or
// feedback, and follow a correction? Eight scripted conversations, three independent trials each; within
// a trial the turns run in order, each on the reply the previous turn produced after `advance`, exactly
// as the page would. Every expectation was written down before the first run.
//
//   npm run eval:converse        # live; uses the keychain item "anthropic-api-key"; about $0.60
//
// Designed demonstration checks on fixtures, not an accuracy estimate. Raw outputs go to
// results/captures/eval-converse-<timestamp>.json.

import Anthropic from "@anthropic-ai/sdk";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import recorded from "../fixtures/captures/recorded.json";
import { EFFORT, MAX_TOKENS, MODEL, PRICE_PER_MTOK } from "../src/shared/constants";
import { type ConvTurn, type ConverseResult, type Next, advance, sanitizeLedger, unverifiedQuotes } from "../src/shared/converse";
import { modelCacheKey } from "../src/shared/hash";
import { CONVERSE_PROMPT_VERSION, PROMPT_VERSION, conversePrompt, converseSchema, routePrompt, routeSchema } from "../src/shared/prompts";
import { enforceSettleInvariant, parseRouteOutput } from "../src/shared/route";
import type { Decision, Fact, Persona, Rule } from "../src/shared/types";

const TRIALS = 3;
const LOCAL_BUDGET_USD = 3;

const read = <T>(p: string): T => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8")) as T;
const persona = read<Persona>("fixtures/persona.json");
const rules = read<Rule[]>("fixtures/rules.json");
const facts = read<Fact[]>("fixtures/facts.json");
const byId = new Map(read<Decision[]>("fixtures/decisions.json").map((d) => [d.id, d]));
const entries = (recorded as { entries: Record<string, { output: unknown }> }).entries;

/** One turn's check: returns the problems, or none. */
type Check = (r: ConverseResult, d: Decision) => string[];

interface Case {
  name: string;
  id: string;
  turns: { text: string; pick?: string }[];
  /** One check per turn. */
  checks: Check[];
}

const has = (cond: boolean, problem: string) => (cond ? [] : [problem]);

// Expectations written before the first run (2026-10-12).
const CASES: Case[] = [
  {
    name: "a bare pick gets a why",
    id: "api-rename",
    turns: [{ text: "Keep user_id." }],
    checks: [(r) => [...has(r.next === "ask", `next ${r.next}, expected ask`), ...has(r.ledger.choice === "B", `choice ${r.ledger.choice}`), ...has(r.reply.includes("?"), "the reply asks nothing")]],
  },
  {
    name: "a full narration goes straight to the read-back",
    id: "api-rename",
    turns: [{ text: "Keep user_id, because renaming breaks every integrator who parses v1 responses. But note account_id in the docs as the internal name." }],
    checks: [
      (r) => [
        ...has(r.next === "confirm", `next ${r.next}, expected confirm`),
        ...has(r.ledger.choice === "B", `choice ${r.ledger.choice}`),
        ...has(r.ledger.conditions.length > 0, "no condition"),
        ...has(/user_id/i.test(r.reply), "the read-back doesn't name the pick"),
        ...has(/account_id|docs/i.test(r.reply), "the read-back doesn't name the condition"),
      ],
    ],
  },
  {
    name: "a question the agent's material answers",
    id: "webhook-rename",
    turns: [{ text: "How many customer endpoints receive these webhooks?" }],
    checks: [
      (r) => [
        ...has(r.ledger.questions.length === 1, `${r.ledger.questions.length} questions`),
        ...has(r.ledger.questions[0]?.answer != null && /300/.test(r.ledger.questions[0].answer), `answer ${JSON.stringify(r.ledger.questions[0]?.answer)}`),
        ...has(r.ledger.choice === "none", `choice ${r.ledger.choice}`),
      ],
    ],
  },
  {
    name: "a question the material can't answer",
    id: "webhook-rename",
    turns: [{ text: "Do any of those customers parse the field by name?" }],
    checks: [
      (r) => [
        ...has(r.ledger.questions.length === 1 && r.ledger.questions[0].answer === null, `answer ${JSON.stringify(r.ledger.questions[0]?.answer)}`),
        ...has(r.ledger.choice === "none", `choice ${r.ledger.choice}`),
        ...has(/don't know|doesn't say|does not say|not sure|ask the agent|no information|isn't in/i.test(r.reply), "the reply doesn't say it doesn't know"),
      ],
    ],
  },
  {
    name: '"just do it" skips the why',
    id: "onsite-flight",
    turns: [{ text: "Just do it, the 9:40." }],
    checks: [(r) => [...has(r.next === "confirm", `next ${r.next}, expected confirm`), ...has(r.ledger.choice === "B", `choice ${r.ledger.choice}`), ...has(!/\bwhy\b/i.test(r.reply), "the reply asks why")]],
  },
  {
    name: "a mu: the question itself is rejected",
    id: "api-rename",
    turns: [{ text: "Neither. Why are we renaming anything in v2 at all? The rename shouldn't be on the table." }],
    checks: [(r) => [...has(r.ledger.choice === "reject", `choice ${r.ledger.choice}, expected reject`), ...has(Boolean(r.ledger.course?.quote), "no course quoted")]],
  },
  {
    name: "routing feedback is heard",
    id: "webhook-rename",
    turns: [{ text: "Keep created. Honestly this shouldn't have come to me; it's the same call as the API rename." }],
    checks: [(r) => [...has(r.ledger.feedback.some((f) => f.kind === "routing"), "no routing feedback"), ...has(r.ledger.choice === "B", `choice ${r.ledger.choice}`)]],
  },
  {
    name: "a correction after the read-back replaces the condition",
    id: "api-rename",
    turns: [{ text: "Keep user_id, because integrators parse v1 responses, as long as we note account_id in the docs." }, { text: "Actually, skip the docs note. Just keep user_id." }],
    checks: [
      (r) => [...has(r.next === "confirm", `next ${r.next}, expected confirm`), ...has(r.ledger.conditions.length > 0, "no condition")],
      (r) => [
        ...has(r.next === "confirm", `next ${r.next}, expected a new read-back`),
        ...has(r.ledger.choice === "B", `choice ${r.ledger.choice}`),
        // Changed after the first run (2026-10-12): this checked that no condition mentioned "docs", but one
        // trial rightly kept the correction itself ("Actually, skip the docs note.") as the new condition.
        // The intent is that the turn-0 condition is gone.
        ...has(!r.ledger.conditions.some((c) => c.turn === 0), "the turn-0 docs condition is still there"),
      ],
    ],
  },
];

const keychainOrEnv = process.env.ANTHROPIC_API_KEY || execFileSync("security", ["find-generic-password", "-a", process.env.USER ?? "", "-s", "anthropic-api-key", "-w"], { encoding: "utf8" }).trim();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || keychainOrEnv, maxRetries: 2 });
let spent = 0;
const raw: unknown[] = [];

/** The card each conversation opens with, as the page has it: the recorded route's route and reason. */
async function cardFor(d: Decision) {
  const key = await modelCacheKey({ model: MODEL, effort: EFFORT, maxTokens: MAX_TOKENS, promptVersion: PROMPT_VERSION, schema: routeSchema(d.options.map((o) => o.key)), prompt: routePrompt(persona, rules, facts, d) });
  const out = parseRouteOutput(entries[key].output, d);
  return { route: enforceSettleInvariant(out, d, rules, facts).route, why_here: out.why_here };
}

async function trial(c: Case, d: Decision, n: number): Promise<{ pass: boolean; detail: string[]; ms: number[] }> {
  const card = await cardFor(d);
  const turns: ConvTurn[] = [];
  const detail: string[] = [];
  const ms: number[] = [];
  let pass = true;
  for (const [i, t] of c.turns.entries()) {
    if (spent > LOCAL_BUDGET_USD) throw new Error(`local budget of $${LOCAL_BUDGET_USD} spent`);
    turns.push(t.pick ? { who: "jordan", text: t.text, pick: t.pick } : { who: "jordan", text: t.text });
    const t0 = Date.now();
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      output_config: { effort: EFFORT, format: { type: "json_schema", schema: converseSchema(d.options.map((o) => o.key)) as unknown as Record<string, unknown> } },
      messages: [{ role: "user", content: conversePrompt(persona, rules, facts, d, card, turns) }],
    });
    ms.push(Date.now() - t0);
    spent += (msg.usage.input_tokens * PRICE_PER_MTOK.input + msg.usage.output_tokens * PRICE_PER_MTOK.output) / 1e6;
    const got = JSON.parse(msg.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "") as { reply: string; next: Next; ledger: unknown };
    // Checked on the raw answer, before sanitizing drops anything, so this can fail.
    const unverified = unverifiedQuotes(got, turns);
    const r = advance(d, turns, got.reply, got.next, sanitizeLedger(got.ledger, d, turns));
    raw.push({ case: c.name, trial: n, turn: i, ms: ms.at(-1), raw: got, after_advance: r });
    const problems = [...c.checks[i](r, d), ...has((r.reply.match(/\?/g) ?? []).length <= 1, "more than one question in the reply"), ...has(unverified === 0, `${unverified} quote(s) not in Jordan's words`)];
    if (problems.length) pass = false;
    detail.push(`turn ${i}: ${problems.length ? `BAD ${problems.join("; ")}` : "ok"} · ${r.next}${r.forced ? ` (forced: ${r.forced})` : ""} · "${r.reply}"`);
    turns.push({ who: "bugme", text: r.reply, next: r.next, ...(r.heard ? { heard: r.heard } : {}) });
  }
  return { pass, detail, ms };
}

/** `npm run eval:converse -- --case <words>` runs only the cases whose name contains the words. */
const only = process.argv.includes("--case") ? process.argv[process.argv.indexOf("--case") + 1] : "";
let failed = 0;
for (const c of CASES.filter((x) => x.name.includes(only))) {
  const d = byId.get(c.id)!;
  // Trials are independent conversations, run side by side; turns within one run in order.
  const results = await Promise.all(Array.from({ length: TRIALS }, (_, n) => trial(c, d, n)));
  const passed = results.filter((r) => r.pass).length;
  if (passed < TRIALS) failed++;
  console.log(`${passed === TRIALS ? "PASS" : "FAIL"} ${passed}/${TRIALS}  ${c.name}  (${results.map((r) => r.ms.map((m) => `${(m / 1000).toFixed(1)}s`).join("+")).join(", ")})`);
  for (const r of results) for (const line of r.detail) console.log(`       ${line}`);
}
mkdirSync(new URL("../results/captures/", import.meta.url), { recursive: true });
const file = `results/captures/eval-converse-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(new URL(`../${file}`, import.meta.url), JSON.stringify({ prompt_version: CONVERSE_PROMPT_VERSION, model: MODEL, trials: TRIALS, spent_usd: spent, raw }, null, 1));
const ran = CASES.filter((x) => x.name.includes(only)).length;
console.log(`\n${ran - failed}/${ran} conversations passed every trial · $${spent.toFixed(2)} · ${file}`);
if (failed) process.exit(1);
