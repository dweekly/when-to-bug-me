// The demo serves a recorded run only on an exact request match. If a prompt, schema, model setting
// or fixture changes without re-recording (npm run record), every default card silently becomes
// "couldn't evaluate". This test catches that before it ships.
import { describe, expect, it } from "vitest";
import recorded from "../../fixtures/captures/recorded.json";
import { EFFORT, MAX_TOKENS, MODEL } from "../../src/shared/constants";
import { modelCacheKey } from "../../src/shared/hash";
import { PROMPT_VERSION, ROUTE_SCHEMA, routePrompt } from "../../src/shared/prompts";
import { decisions, facts, persona, rules } from "./helpers";

const entries = (recorded as { entries: Record<string, unknown> }).entries;

describe("the recorded run", () => {
  it("has an answer for every decision under the default rules and facts, for the current prompts", async () => {
    const missing: string[] = [];
    for (const d of decisions) {
      const key = await modelCacheKey({ model: MODEL, effort: EFFORT, maxTokens: MAX_TOKENS, promptVersion: PROMPT_VERSION, schema: ROUTE_SCHEMA, prompt: routePrompt(persona, rules, facts, d) });
      if (!(key in entries)) missing.push(d.id);
    }
    expect(missing, "re-record with `npm run record`").toEqual([]);
  });
});
