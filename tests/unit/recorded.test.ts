// The demo serves a recorded run only on an exact request match. If a prompt, schema, model setting
// or fixture changes without re-recording (npm run record), every default card silently becomes
// "couldn't evaluate". This test catches that before it ships.
import { describe, expect, it } from "vitest";
import recorded from "../../fixtures/captures/recorded.json";
import { EFFORT, MAX_TOKENS, MODEL, TITLE_MAX_TOKENS, TITLE_MODEL } from "../../src/shared/constants";
import { type ConvTurn, type ConverseResult, type Next, advance, closeInputs, outcomeOf, sanitizeLedger, unverifiedQuotes } from "../../src/shared/converse";
import { parseTitles } from "../../src/shared/titles";
import { modelCacheKey } from "../../src/shared/hash";
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
} from "../../src/shared/prompts";
import { CONVERSATIONS, EXAMPLES, scriptTurn } from "../../src/shared/examples";
import { answerParts, guidanceText, parseParseOutput } from "../../src/shared/parse";
import { enforceSettleInvariant, parseRouteOutput } from "../../src/shared/route";
import { decisions, facts, persona, rules } from "./helpers";

const entries = (recorded as { entries: Record<string, unknown> }).entries;

describe("the recorded run", () => {
  it("has an answer for every decision under the default rules and facts, for the current prompts", async () => {
    const missing: string[] = [];
    for (const d of decisions) {
      const key = await modelCacheKey({ model: MODEL, effort: EFFORT, maxTokens: MAX_TOKENS, promptVersion: PROMPT_VERSION, schema: routeSchema(d.options.map((o) => o.key)), prompt: routePrompt(persona, rules, facts, d) });
      if (!(key in entries)) missing.push(d.id);
      // A recorded answer must also pass today's parser, or the card would fail to evaluate anyway.
      else expect(() => parseRouteOutput((entries[key] as { output: unknown }).output, d), d.id).not.toThrow();
    }
    expect(missing, "re-record with `npm run record`").toEqual([]);
  });
});

describe("Jordan's recorded narrations", () => {
  const key = (promptVersion: string, schema: unknown, prompt: string) => modelCacheKey({ model: MODEL, effort: EFFORT, maxTokens: MAX_TOKENS, promptVersion, schema, prompt });
  for (const ex of EXAMPLES) {
    it(`${ex.id}: the parse, its questions and the guidance call it leads to are all recorded`, async () => {
      const d = decisions.find((x) => x.id === ex.id)!;
      const text = ex.narration.trim();
      const pk = await key(PARSE_PROMPT_VERSION, parseSchema(d.options.map((o) => o.key)), parsePrompt(persona, d, text));
      expect(pk in entries, "re-record with `npm run record`").toBe(true);
      const parsed = parseParseOutput((entries[pk] as { output: unknown }).output, d, text);
      expect(parsed.choice, "the tour picks this option by voice").toBe(ex.choice);
      for (const m of parsed.marks.filter((x) => x.kind === "ask")) {
        expect((await key(PROMPT_VERSION, ASK_SCHEMA, askPrompt(persona, d, m.quote))) in entries, `ask: ${m.quote}`).toBe(true);
      }
      const evidence = guidanceText(answerParts(parsed.marks)) || ex.reason;
      const others = decisions.filter((x) => x.id !== d.id);
      expect((await key(PROMPT_VERSION, FACT_SCHEMA, factPrompt(persona, rules, facts, d, ex.choice, evidence, others))) in entries, "fact").toBe(true);
    });
  }
});

describe("the recorded morning matches the proposal (docs/STAGE-5.md)", () => {
  const NINE = ["api-rename", "webhook-rename", "sdk-dependency", "settings-redesign", "free-tier", "reconciliation-path", "berlin-sync", "onsite-flight", "incident-action-items"];
  const recordedRoute = async (d: (typeof decisions)[number]) => {
    const key = await modelCacheKey({ model: MODEL, effort: EFFORT, maxTokens: MAX_TOKENS, promptVersion: PROMPT_VERSION, schema: routeSchema(d.options.map((o) => o.key)), prompt: routePrompt(persona, rules, facts, d) });
    const parsed = parseRouteOutput((entries[key] as { output: unknown }).output, d);
    return { ...enforceSettleInvariant(parsed, d, rules, facts), clearing_rule: parsed.clearing_rule };
  };
  it("raises 40 questions; the nine reach Jordan and the other 31 are settled on their 'do it' option under R2 or R7", async () => {
    expect(decisions).toHaveLength(40);
    const clearing = new Set([rules.find((r) => r.id === "R2")!.text, rules.find((r) => r.id === "R7")!.text]);
    const wrong: string[] = [];
    for (const d of decisions) {
      const out = await recordedRoute(d);
      if (NINE.includes(d.id)) {
        if (out.route === "settle") wrong.push(`${d.id} settled`);
      } else if (out.route !== "settle" || out.settle_option !== d.recommended || !clearing.has(out.clearing_rule)) {
        wrong.push(`${d.id}: ${out.route} ${out.settle_option ?? ""} ${out.clearing_rule ?? ""}`.trim());
      }
    }
    expect(wrong).toEqual([]);
  });
  it("Launch comes first, with the API rename first in it (it unblocks six agents)", () => {
    const api = decisions.find((d) => d.id === "api-rename")!;
    expect(api.unblocks).toBe(6);
  });
});

describe("the recorded guidance reaches the decisions it should", () => {
  const after = (label: string) => Object.values(entries as Record<string, { label: string; output: { guess: { option: string; p: number }[]; fact_quoted: string } }>).filter((e) => e.label === label);
  it("the flight reason re-checks the Berlin invite: the guess turns to declining, quoting the kept fact", () => {
    const rs = after("route berlin-sync [after onsite-flight]");
    expect(rs.length).toBeGreaterThan(0);
    for (const r of rs) {
      expect(r.output.guess.reduce((a, b) => (b.p > a.p ? b : a)).option).toBe("B");
      expect(r.output.fact_quoted).toMatch(/8:30|drop-off/);
    }
  });
  it("the API reason re-checks the webhook rename: the guess turns to keeping the name, quoting the kept fact", () => {
    const rs = after("route webhook-rename [after api-rename]");
    expect(rs.length).toBeGreaterThan(0);
    for (const r of rs) {
      expect(r.output.guess.reduce((a, b) => (b.p > a.p ? b : a)).option).toBe("B");
      expect(r.output.fact_quoted).toMatch(/field names|renam/i);
    }
  });
});

describe("stage 6: the recorded conversations and titles (docs/STAGE-6.md)", () => {
  const key = (parts: { model?: string; maxTokens?: number; promptVersion: string; schema: unknown; prompt: string }) =>
    modelCacheKey({ model: parts.model ?? MODEL, effort: EFFORT, maxTokens: parts.maxTokens ?? MAX_TOKENS, promptVersion: parts.promptVersion, schema: parts.schema, prompt: parts.prompt });
  const output = (k: string) => (entries[k] as { output: unknown } | undefined)?.output;

  /** Decisions whose card shows the headline because the fast model's title never passed the checks.
   *  dockerfile-format was one until the 2026-10-13 recording, which titled it within the limit. */
  const UNTITLED: string[] = [];
  it("every decision but the known exception has a recorded emoji and title that pass today's checks", async () => {
    const missing: string[] = [];
    for (const d of decisions) {
      const out = output(await key({ model: TITLE_MODEL, maxTokens: TITLE_MAX_TOKENS, promptVersion: TITLE_PROMPT_VERSION, schema: titleSchema(d.options.map((o) => o.key)), prompt: titlePrompt(d) }));
      if (out === undefined) missing.push(d.id);
      else expect(() => parseTitles(out, d), d.id).not.toThrow();
    }
    expect(missing).toEqual(UNTITLED);
  });

  for (const s of CONVERSATIONS) {
    it(`${s.id}${s.variant ? ` (${s.variant})` : ""}: the scripted conversation replays from the recording and follows the script, and its guidance call is recorded`, async () => {
      const d = decisions.find((x) => x.id === s.id)!;
      const routed = parseRouteOutput(output(await key({ promptVersion: PROMPT_VERSION, schema: routeSchema(d.options.map((o) => o.key)), prompt: routePrompt(persona, rules, facts, d) })), d);
      const card = { route: enforceSettleInvariant(routed, d, rules, facts).route, why_here: routed.why_here };
      const turns: ConvTurn[] = [];
      let last: ConverseResult | null = null;
      for (const [i, t] of s.turns.entries()) {
        turns.push(scriptTurn(t));
        const raw = output(await key({ promptVersion: CONVERSE_PROMPT_VERSION, schema: converseSchema(d.options.map((o) => o.key)), prompt: conversePrompt(persona, rules, facts, d, card, turns) })) as { reply: string; next: Next; ledger: unknown } | undefined;
        expect(raw, `turn ${i} is recorded; re-record with \`npm run record\``).toBeDefined();
        expect(unverifiedQuotes(raw, turns), `turn ${i}: quotes not in Jordan's words`).toBe(0);
        last = advance(d, turns, raw!.reply, raw!.next, sanitizeLedger(raw!.ledger, d, turns));
        expect(last.next, `turn ${i}`).toBe(s.expect[i]);
        turns.push({ who: "bugme", text: last.reply, next: last.next, ...(last.heard ? { heard: last.heard } : {}) });
      }
      expect(outcomeOf(d, last!.ledger)).toEqual({ kind: "option", key: s.choice });
      const c = closeInputs(d, turns, last!.ledger);
      if (c.evidence) {
        const others = decisions.filter((x) => x.id !== d.id);
        expect(output(await key({ promptVersion: PROMPT_VERSION, schema: FACT_SCHEMA, prompt: factPrompt(persona, rules, facts, d, s.choice, c.evidence, others) })), "fact").toBeDefined();
      }
    });
  }
});
