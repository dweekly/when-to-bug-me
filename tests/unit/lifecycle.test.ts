// src/shared/lifecycle.ts: the answer lifecycle's choices (push back, ask why, propose guidance) and
// the firefly's glow (build plan, "The answer lifecycle" and item 6).

import { describe, expect, it } from "vitest";
import { MAX_PUSHBACKS_PER_SESSION, MIN_BASIS_CHARS, WHY_THRESHOLD } from "../../src/shared/constants";
import {
  alreadyKept,
  GLOW_START,
  GLOW_STEP,
  type Guess,
  hasBasis,
  moodAfter,
  substantiveBasis,
  nextGlow,
  shouldAskWhy,
  shouldProposeGuidance,
  shouldPushBack,
  surprised,
  topGuess,
} from "../../src/shared/lifecycle";

const confident: Guess = [
  { option: "A", p: 0.85 },
  { option: "B", p: 0.15 },
];
const coinFlip: Guess = [
  { option: "A", p: 0.55 },
  { option: "B", p: 0.45 },
];
const atThreshold: Guess = [
  { option: "A", p: WHY_THRESHOLD },
  { option: "B", p: 1 - WHY_THRESHOLD },
];
const REASON = "I do school drop-off before 8:30, so no early flights.";

describe("hasBasis and topGuess", () => {
  it("counts any non-blank reason as a basis; only the glow applies MIN_BASIS_CHARS", () => {
    expect(hasBasis(undefined)).toBe(false);
    expect(hasBasis("")).toBe(false);
    expect(hasBasis("   ")).toBe(false);
    expect(hasBasis("x".repeat(MIN_BASIS_CHARS - 1))).toBe(true);
    expect(substantiveBasis(`   ${"x".repeat(MIN_BASIS_CHARS - 1)}   `)).toBe(false);
    expect(substantiveBasis("x".repeat(MIN_BASIS_CHARS))).toBe(true);
  });

  it("picks the most likely option", () => {
    expect(topGuess(confident)).toEqual({ option: "A", p: 0.85 });
    expect(topGuess([{ option: "A", p: 0.2 }, { option: "B", p: 0.5 }, { option: "C", p: 0.3 }]).option).toBe("B");
  });
});

describe("shouldPushBack", () => {
  it("pushes back when the choice contradicts the record and the ration is not spent", () => {
    for (let used = 0; used < MAX_PUSHBACKS_PER_SESSION; used++) {
      expect(shouldPushBack("No new runtime dependencies in the SDKs.", used)).toBe(true);
    }
  });

  it("stops once MAX_PUSHBACKS_PER_SESSION is spent", () => {
    expect(shouldPushBack("No new runtime dependencies in the SDKs.", MAX_PUSHBACKS_PER_SESSION)).toBe(false);
    expect(shouldPushBack("No new runtime dependencies in the SDKs.", MAX_PUSHBACKS_PER_SESSION + 1)).toBe(false);
  });

  it("never pushes back without a conflicting quote", () => {
    expect(shouldPushBack(null, 0)).toBe(false);
    expect(shouldPushBack("", 0)).toBe(false);
  });
});

describe("shouldAskWhy", () => {
  it("asks when the answer goes against a confident guess and no basis was given", () => {
    expect(surprised("B", confident)).toBe(true);
    expect(shouldAskWhy("B", confident, "")).toBe(true);
    expect(shouldAskWhy("B", confident, undefined)).toBe(true);
  });

  it("asks at exactly the threshold, not below it", () => {
    expect(shouldAskWhy("B", atThreshold, "")).toBe(true);
    expect(shouldAskWhy("B", coinFlip, "")).toBe(false);
  });

  it("does not ask when the answer agrees with the guess", () => {
    expect(shouldAskWhy("A", confident, "")).toBe(false);
  });

  it("does not ask when a basis was already given, so it never asks twice", () => {
    expect(shouldAskWhy("B", confident, REASON)).toBe(false);
    // The why prompt's own answer becomes the basis; asking again with it in hand returns false.
    const first = shouldAskWhy("B", confident, "");
    const second = shouldAskWhy("B", confident, REASON);
    expect([first, second]).toEqual([true, false]);
  });

  it("does not ask again when a short reason was already given", () => {
    expect(shouldAskWhy("B", confident, "because")).toBe(false);
    expect(shouldAskWhy("B", confident, "  ")).toBe(true);
  });
});

describe("shouldProposeGuidance", () => {
  it("proposes when there is a basis and the answer surprised Bug Me", () => {
    expect(shouldProposeGuidance("B", "B", confident, REASON)).toBe(true);
  });

  it("proposes when there is a basis and the answer went against the agent's recommendation", () => {
    expect(shouldProposeGuidance("B", "A", coinFlip, REASON)).toBe(true);
  });

  it("does not propose when the answer agrees with both the guess and the recommendation", () => {
    expect(shouldProposeGuidance("A", "A", confident, REASON)).toBe(false);
  });

  it("never proposes without a basis", () => {
    expect(shouldProposeGuidance("B", "A", confident, "")).toBe(false);
    expect(shouldProposeGuidance("B", "A", confident, "   ")).toBe(false);
  });
});

describe("nextGlow", () => {
  const answered = (route: "settle" | "check_in" | "decide", basis: boolean, againstRecommendation = false) =>
    ({ kind: "answered", route, basis, againstRecommendation }) as const;

  it("brightens for a reason, and more for an override with a reason", () => {
    expect(nextGlow(0.3, answered("check_in", true))).toBeCloseTo(0.3 + GLOW_STEP.basis, 12);
    expect(nextGlow(0.3, answered("decide", true, true))).toBeCloseTo(0.3 + GLOW_STEP.basis + GLOW_STEP.overrideWithBasis, 12);
  });

  it("brightens for kept guidance, rule edits and correction marks", () => {
    expect(nextGlow(0.3, { kind: "guidance_kept" })).toBeCloseTo(0.3 + GLOW_STEP.guidanceKept, 12);
    expect(nextGlow(0.3, { kind: "rule_edited" })).toBeCloseTo(0.3 + GLOW_STEP.ruleEdited, 12);
    expect(nextGlow(0.3, { kind: "correction_mark" })).toBeCloseTo(0.3 + GLOW_STEP.correction, 12);
  });

  it("dims only for a substantive decision answered without a basis", () => {
    expect(GLOW_STEP.noBasisOnDecision).toBeLessThan(0);
    expect(nextGlow(0.3, answered("decide", false))).toBeCloseTo(0.3 + GLOW_STEP.noBasisOnDecision, 12);
    expect(nextGlow(0.3, answered("decide", false, true))).toBe(0.3); // an override is a contribution, explained or not
    expect(nextGlow(0.3, answered("check_in", false))).toBe(0.3);
    expect(nextGlow(0.3, answered("check_in", false, true))).toBe(0.3);
    expect(nextGlow(0.3, answered("settle", false))).toBe(0.3);
    expect(nextGlow(0.3, { kind: "shouldnt_have_come" })).toBe(0.3);
  });

  it("clamps to [0, 1]", () => {
    expect(nextGlow(0.99, answered("decide", true, true))).toBe(1);
    expect(nextGlow(1, { kind: "guidance_kept" })).toBe(1);
    expect(nextGlow(0.01, answered("decide", false))).toBe(0);
    expect(nextGlow(0, answered("decide", false))).toBe(0);
    expect(nextGlow(5, { kind: "shouldnt_have_come" })).toBe(1);
    expect(nextGlow(-5, { kind: "shouldnt_have_come" })).toBe(0);
  });

  it("starts in range", () => {
    expect(GLOW_START).toBeGreaterThanOrEqual(0);
    expect(GLOW_START).toBeLessThanOrEqual(1);
  });
});

describe("moodAfter", () => {
  it("rests when nothing waits, whatever just happened", () => {
    expect(moodAfter(null, 0.2, 0)).toBe("resting");
    expect(moodAfter({ kind: "shouldnt_have_come" }, 0.9, 0)).toBe("resting");
    expect(moodAfter({ kind: "answered", route: "decide", basis: false, againstRecommendation: false }, 0.1, 0)).toBe("resting");
  });

  it("is sheepish after 'this shouldn't have come to me'", () => {
    expect(moodAfter({ kind: "shouldnt_have_come" }, 0.9, 3)).toBe("sheepish");
  });

  it("is dim after a decision accepted without a basis", () => {
    expect(moodAfter({ kind: "answered", route: "decide", basis: false, againstRecommendation: false }, 0.9, 3)).toBe("dim");
    expect(moodAfter({ kind: "answered", route: "check_in", basis: false, againstRecommendation: false }, 0.2, 3)).toBe("neutral");
  });

  it("glows at 0.6 and above, otherwise neutral", () => {
    expect(moodAfter({ kind: "guidance_kept" }, 0.6, 1)).toBe("glowing");
    expect(moodAfter({ kind: "guidance_kept" }, 0.59, 1)).toBe("neutral");
    expect(moodAfter(null, 0.35, 1)).toBe("neutral");
  });
});

describe("alreadyKept (a retry of guidance an earlier press already saved, on the live queue)", () => {
  const facts = [
    { id: "F1", text: "Keep existing names.", source: "", scope: "alpha" },
    { id: "F2", text: "Ask before deleting.", source: "", scope: "all" },
  ];
  it("finds the same text in the same scope", () => {
    expect(alreadyKept([...facts, { id: "F3", text: "Ship on Fridays.", source: "", scope: "all" }], { kind: "add", replaces: "", scope: "all" }, "Ship on Fridays.", "x")?.id).toBe("F3");
  });
  it("is not fooled by the same text in a different scope", () => {
    expect(alreadyKept(facts, { kind: "add", replaces: "", scope: "all" }, "Keep existing names.", "x")).toBeUndefined();
  });
  it("for a replacement, needs the text under the id it replaces", () => {
    expect(alreadyKept(facts, { kind: "replace", replaces: "F1", scope: "all" }, "Ask before deleting.", "x")).toBeUndefined();
    const replaced = [{ ...facts[0], text: "Keep names in v2.", scope: "all" }, facts[1]];
    expect(alreadyKept(replaced, { kind: "replace", replaces: "F1", scope: "all" }, "Keep names in v2.", "x")?.id).toBe("F1");
  });
});
