// The think-out-loud eval: does the parse prompt pick the right choice out of someone talking a
// decision through, and quote their words exactly? Three fresh live calls per narration, each checked
// against an expectation written down before running.
//
//   npm run eval:parse        # live; uses the keychain item "anthropic-api-key"; about $0.40
//
// Designed demonstration checks on fixtures, not an accuracy estimate. Raw outputs go to
// results/captures/eval-parse-<timestamp>.json.

import Anthropic from "@anthropic-ai/sdk";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { EFFORT, MAX_TOKENS, MODEL, PRICE_PER_MTOK } from "../src/shared/constants";
import { EXAMPLES } from "../src/shared/examples";
import { parseParseOutput } from "../src/shared/parse";
import { PARSE_PROMPT_VERSION, parsePrompt, parseSchema } from "../src/shared/prompts";
import type { Decision, Mark, Persona } from "../src/shared/types";

const TRIALS = 3;
const LOCAL_BUDGET_USD = 2;

const read = <T>(p: string): T => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8")) as T;
const persona = read<Persona>("fixtures/persona.json");
const byId = new Map(read<Decision[]>("fixtures/decisions.json").map((d) => [d.id, d]));
const narration = (id: string) => EXAMPLES.find((e) => e.id === id)!.narration;

interface Case {
  name: string;
  id: string;
  text: string;
  choice: string;
  /** Mark kinds that must be present. "choice" must be absent when the expected choice is "none". */
  kinds: Mark["kind"][];
}

// Expectations written before the first run (2026-10-12).
const CASES: Case[] = [
  { name: "all four kinds", id: "api-rename", text: narration("api-rename"), choice: "B", kinds: ["choice", "why", "but", "ask"] },
  { name: "a bare choice", id: "onsite-flight", text: narration("onsite-flight"), choice: "B", kinds: ["choice"] },
  { name: "changes their mind", id: "api-rename", text: "I'd rename it to account_id, it's cleaner. Actually no, keep user_id, because the integrations matter more than tidy names.", choice: "B", kinds: ["choice", "why"] },
  { name: "only weighing, one question", id: "api-rename", text: "I'm not sure yet. How many customers still call v1?", choice: "none", kinds: ["ask"] },
  { name: "neither option", id: "settings-redesign", text: "Neither, honestly. Ship the current page as is and test both versions with five customers first.", choice: "other", kinds: [] },
  { name: "yes, with a condition", id: "incident-action-items", text: "File them all, as long as each ticket links the incident doc.", choice: "A", kinds: ["choice", "but"] },
];

const keychainOrEnv = process.env.ANTHROPIC_API_KEY || execFileSync("security", ["find-generic-password", "-a", process.env.USER ?? "", "-s", "anthropic-api-key", "-w"], { encoding: "utf8" }).trim();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || keychainOrEnv, maxRetries: 2 });
let spent = 0;
const raw: unknown[] = [];

async function trial(c: Case, d: Decision): Promise<{ pass: boolean; detail: string; ms: number }> {
  if (spent > LOCAL_BUDGET_USD) throw new Error(`local budget of $${LOCAL_BUDGET_USD} spent`);
  const t0 = Date.now();
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    output_config: { effort: EFFORT, format: { type: "json_schema", schema: parseSchema(d.options.map((o) => o.key)) as unknown as Record<string, unknown> } },
    messages: [{ role: "user", content: parsePrompt(persona, d, c.text) }],
  });
  const ms = Date.now() - t0;
  spent += (msg.usage.input_tokens * PRICE_PER_MTOK.input + msg.usage.output_tokens * PRICE_PER_MTOK.output) / 1e6;
  const text = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
  const got = JSON.parse(text) as { choice: string; marks: unknown[] };
  const out = parseParseOutput(got, d, c.text);
  raw.push({ case: c.name, ms, out: got });
  const kinds = new Set(out.marks.map((m) => m.kind));
  const dropped = got.marks.length - out.marks.length;
  const problems = [
    out.choice !== c.choice ? `choice ${out.choice}, expected ${c.choice}` : "",
    ...c.kinds.filter((k) => !kinds.has(k)).map((k) => `no ${k} mark`),
    c.choice === "none" && kinds.has("choice") ? "a choice mark with no choice" : "",
    dropped ? `${dropped} mark(s) not quoted exactly` : "",
  ].filter(Boolean);
  return { pass: !problems.length, detail: problems.join("; ") || out.marks.map((m) => `${m.kind}: "${m.quote}"`).join(" | "), ms };
}

let failed = 0;
for (const c of CASES) {
  const d = byId.get(c.id)!;
  const results = await Promise.all(Array.from({ length: TRIALS }, () => trial(c, d)));
  const passed = results.filter((r) => r.pass).length;
  if (passed < TRIALS) failed++;
  console.log(`${passed === TRIALS ? "PASS" : "FAIL"} ${passed}/${TRIALS}  ${c.name}  (${results.map((r) => `${(r.ms / 1000).toFixed(1)}s`).join(", ")})`);
  for (const r of results) console.log(`       ${r.pass ? "ok " : "BAD"} ${r.detail}`);
}
mkdirSync(new URL("../results/captures/", import.meta.url), { recursive: true });
const file = `results/captures/eval-parse-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(new URL(`../${file}`, import.meta.url), JSON.stringify({ prompt_version: PARSE_PROMPT_VERSION, model: MODEL, trials: TRIALS, spent_usd: spent, raw }, null, 1));
console.log(`\n${CASES.length - failed}/${CASES.length} narrations passed every trial · $${spent.toFixed(2)} · ${file}`);
if (failed) process.exit(1);
