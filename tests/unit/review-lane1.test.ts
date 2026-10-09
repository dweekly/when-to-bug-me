// Regression tests for the lane 1 review: whole-rule settlement, short whole quotes, send-down
// coverage, the inclusive probability tolerance, and reason detection apart from the glow threshold.
import { describe, expect, it } from "vitest";
import { hasBasis, shouldAskWhy, shouldProposeGuidance, substantiveBasis } from "../../src/shared/lifecycle";
import { RouteParseError, enforceSettleInvariant, parseRouteOutput, verifyQuote } from "../../src/shared/route";
import { decision, routeOutput, rules } from "./helpers";

const formatter = decision("formatter-run");
const R2 = rules.find((r) => r.id === "R2")!;

describe("settling needs a whole rule", () => {
  it("a fragment of the clearing rule does not settle", () => {
    const out = routeOutput(formatter, { route: "settle", settle_option: "A", clearing_rule: "formatting, lint fixes" });
    expect(enforceSettleInvariant(out, formatter, rules).route).toBe("check_in");
  });
  it("the whole rule, lightly reformatted, settles", () => {
    const out = routeOutput(formatter, { route: "settle", settle_option: "A", clearing_rule: ` ${R2.text.toLowerCase()} ` });
    expect(enforceSettleInvariant(out, formatter, rules).route).toBe("settle");
  });
  it("a short rule quoted in full is accepted", () => {
    const short = [{ id: "R2", text: "Just do it." }];
    expect(verifyQuote("just do it", short.map((r) => r.text))).toBe("Just do it.");
    const out = routeOutput(formatter, { route: "settle", settle_option: "A", clearing_rule: "Just do it." });
    expect(enforceSettleInvariant(out, formatter, short).route).toBe("settle");
  });
});

describe("parseRouteOutput", () => {
  const base = (over: Record<string, unknown>) => ({ ...routeOutput(formatter), ...over });
  it("rejects send_down that misses an option or repeats one", () => {
    expect(() => parseRouteOutput(base({ send_down: [] }), formatter)).toThrow(RouteParseError);
    expect(() =>
      parseRouteOutput(base({ send_down: [{ option: "A", instruction: "x" }, { option: "A", instruction: "y" }] }), formatter),
    ).toThrow(RouteParseError);
  });
  it("accepts guesses summing exactly to the documented endpoints 0.98 and 1.02", () => {
    for (const p of [0.49, 0.51]) {
      const out = parseRouteOutput(base({ guess: [{ option: "A", p }, { option: "B", p }] }), formatter);
      expect(out.guess[0].p).toBeCloseTo(0.5);
    }
  });
});

describe("a short reason still counts as a reason", () => {
  const guess = [{ option: "A", p: 0.7 }, { option: "B", p: 0.3 }];
  it("is not asked for again, and is sent for guidance", () => {
    expect(hasBasis("No renames.")).toBe(true);
    expect(shouldAskWhy("B", guess, "No renames.")).toBe(false);
    expect(shouldProposeGuidance("B", "A", guess, "No renames.")).toBe(true);
  });
  it("but is below the glow's substantive threshold", () => {
    expect(substantiveBasis("No renames.")).toBe(false);
    expect(hasBasis("   ")).toBe(false);
  });
});
