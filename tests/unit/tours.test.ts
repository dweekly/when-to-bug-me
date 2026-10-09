// The tour catalog is a script over recorded Claude output: every reason a tour uses must be a
// recorded example for the same decision and choice, so a tour never leaves the recorded path when
// live calls are off. (tests/unit/recorded.test.ts checks the recording covers every example.)
import { describe, expect, it } from "vitest";
import { EXAMPLES } from "../../src/shared/examples";
import { TOURS, TOUR_IDS } from "../../src/shared/tours";
import { decisions } from "./helpers";

const ids = new Set(decisions.map((d) => d.id));

describe("tour catalog", () => {
  it("has unique ids", () => {
    expect(TOUR_IDS.size).toBe(TOURS.length);
  });
  for (const t of TOURS) {
    it(`${t.id}: every scripted reason is a recorded example`, () => {
      for (const p of t.path) {
        expect(ids.has(p.decision), p.decision).toBe(true);
        if (p.reason === "example") {
          expect(EXAMPLES.some((e) => e.id === p.decision && e.choice === p.choice), `${t.id} ${p.decision}`).toBe(true);
        }
      }
      for (const s of t.steps) {
        if (s.example?.decision) expect(EXAMPLES.some((e) => e.id === s.example!.decision), `${t.id} step ${s.title}`).toBe(true);
        if (s.go?.startsWith("#/d/")) expect(ids.has(s.go.slice(4)), s.go).toBe(true);
      }
      expect(t.steps.length).toBeGreaterThan(0);
    });
  }
});
