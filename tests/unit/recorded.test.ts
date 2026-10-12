// The demo serves a recorded run only on an exact request match. If a prompt, schema, model setting
// or fixture changes without re-recording (npm run record), every default card silently becomes
// "couldn't evaluate". This test catches that before it ships.
import { describe, expect, it } from "vitest";
import recorded from "../../fixtures/captures/recorded.json";
import { EFFORT, MAX_TOKENS, MODEL } from "../../src/shared/constants";
import { modelCacheKey } from "../../src/shared/hash";
import { ASK_SCHEMA, FACT_SCHEMA, PARSE_PROMPT_VERSION, PROMPT_VERSION, askPrompt, factPrompt, parsePrompt, parseSchema, routeSchema, routePrompt } from "../../src/shared/prompts";
import { EXAMPLES } from "../../src/shared/examples";
import { answerParts, guidanceText, parseParseOutput } from "../../src/shared/parse";
import { parseRouteOutput } from "../../src/shared/route";
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
