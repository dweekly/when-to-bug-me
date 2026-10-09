// src/shared/route.ts: validating the routing answer, checking quotes against the current rules and
// facts, and the code-enforced settle invariant (build plan, "Code-enforced invariant").

import { describe, expect, it } from "vitest";
import { SETTLE_MAX_COST_USD } from "../../src/shared/constants";
import {
  RouteParseError,
  enforceSettleInvariant,
  normalizeQuote,
  parseRouteOutput,
  verifiedQuotes,
  verifyQuote,
} from "../../src/shared/route";
import type { Rule } from "../../src/shared/types";
import { decision, facts, routeOutput, rule, rules } from "./helpers";

const R1 = rule("R1").text; // "Changes to the public API or the SDK interfaces are mine to decide."
const R2 = rule("R2").text; // housekeeping: just do it

describe("parseRouteOutput", () => {
  const d = decision("api-rename");

  it("accepts a valid output and returns every field", () => {
    const raw = routeOutput(d, { route: "decide", rule_quoted: R1, why_here: "Your rule says so." });
    const out = parseRouteOutput(raw, d);
    expect(out.route).toBe("decide");
    expect(out.settle_option).toBe("");
    expect(out.rule_quoted).toBe(R1);
    expect(out.guess.map((g) => g.option).sort()).toEqual(["A", "B"]);
    expect(out.send_down).toHaveLength(2);
  });

  it("rejects an unknown option key in the guess", () => {
    const raw = routeOutput(d, { guess: [{ option: "A", p: 0.5 }, { option: "Z", p: 0.5 }] });
    expect(() => parseRouteOutput(raw, d)).toThrow(RouteParseError);
  });

  it("rejects a guess that leaves out an option", () => {
    const raw = routeOutput(d, { guess: [{ option: "A", p: 1 }] });
    expect(() => parseRouteOutput(raw, d)).toThrow(/every option/);
  });

  it("rejects a guess that repeats an option", () => {
    const raw = routeOutput(d, { guess: [{ option: "A", p: 0.5 }, { option: "A", p: 0.5 }] });
    expect(() => parseRouteOutput(raw, d)).toThrow(RouteParseError);
  });

  it("rejects probabilities that do not sum to about 1", () => {
    for (const [a, b] of [
      [0.5, 0.3],
      [0.7, 0.4],
    ]) {
      const raw = routeOutput(d, { guess: [{ option: "A", p: a }, { option: "B", p: b }] });
      expect(() => parseRouteOutput(raw, d)).toThrow(/sums to/);
    }
  });

  it("rejects a probability outside [0, 1] or not a number", () => {
    for (const p of [-0.1, 1.1, Number.NaN]) {
      const raw = routeOutput(d, { guess: [{ option: "A", p }, { option: "B", p: 1 - p }] });
      expect(() => parseRouteOutput(raw, d)).toThrow(RouteParseError);
    }
    const raw = { ...routeOutput(d), guess: [{ option: "A", p: "0.5" }, { option: "B", p: 0.5 }] };
    expect(() => parseRouteOutput(raw, d)).toThrow(RouteParseError);
  });

  it("renormalizes probabilities within the tolerance so they sum to exactly 1", () => {
    const raw = routeOutput(d, { guess: [{ option: "A", p: 0.6 }, { option: "B", p: 0.41 }] });
    const out = parseRouteOutput(raw, d);
    const total = out.guess.reduce((s, g) => s + g.p, 0);
    expect(total).toBeCloseTo(1, 12);
    expect(out.guess.find((g) => g.option === "A")!.p).toBeCloseTo(0.6 / 1.01, 12);
  });

  it("rejects settle without a valid settle_option", () => {
    for (const settle_option of ["", "Z"]) {
      const raw = routeOutput(d, { route: "settle", settle_option });
      expect(() => parseRouteOutput(raw, d)).toThrow(/settle_option/);
    }
    const missing: Record<string, unknown> = { ...routeOutput(d, { route: "settle" }) };
    delete missing.settle_option;
    expect(() => parseRouteOutput(missing, d)).toThrow(/settle_option/);
  });

  it("accepts settle with a real option, and clears settle_option on other routes", () => {
    expect(parseRouteOutput(routeOutput(d, { route: "settle", settle_option: "B" }), d).settle_option).toBe("B");
    expect(parseRouteOutput(routeOutput(d, { route: "decide", settle_option: "B" }), d).settle_option).toBe("");
  });

  it("rejects unknown route, reversible, cost and problem values", () => {
    for (const bad of [{ route: "ask" }, { reversible: "maybe" }, { cost: "free" }, { problem: "bad" }]) {
      const raw = { ...routeOutput(d), ...bad };
      expect(() => parseRouteOutput(raw, d)).toThrow(RouteParseError);
    }
  });

  it("rejects unknown option keys in conflicts and send_down", () => {
    expect(() => parseRouteOutput(routeOutput(d, { conflicts: [{ option: "Z", quoted: "x" }] }), d)).toThrow(RouteParseError);
    expect(() => parseRouteOutput(routeOutput(d, { send_down: [{ option: "Z", instruction: "x" }] }), d)).toThrow(RouteParseError);
  });

  it("rejects a missing or non-string headline", () => {
    const missing: Record<string, unknown> = { ...routeOutput(d) };
    delete missing.headline;
    expect(() => parseRouteOutput(missing, d)).toThrow(/headline/);
    expect(() => parseRouteOutput({ ...routeOutput(d), headline: 3 }, d)).toThrow(/headline/);
  });

  it("rejects non-objects and missing arrays", () => {
    expect(() => parseRouteOutput(null, d)).toThrow(RouteParseError);
    expect(() => parseRouteOutput("route", d)).toThrow(RouteParseError);
    expect(() => parseRouteOutput({ ...routeOutput(d), guess: undefined }, d)).toThrow(/guess/);
    expect(() => parseRouteOutput({ ...routeOutput(d), send_down: undefined }, d)).toThrow(/send_down/);
  });
});

describe("verifyQuote", () => {
  const sources = rules.map((r) => r.text);

  it("matches an exact quote and returns the source text", () => {
    expect(verifyQuote(R1, sources)).toBe(R1);
  });

  it("matches a lightly reformatted quote: case, whitespace, trailing period", () => {
    const messy = `  changes to the PUBLIC api   or the sdk\ninterfaces are mine to decide  `;
    expect(verifyQuote(messy, sources)).toBe(R1);
    expect(verifyQuote(R1.replace(/\.$/, ""), sources)).toBe(R1);
  });

  it("matches across curly and straight quotes", () => {
    const src = [`Don't ship on Fridays unless the "release" label is set.`];
    expect(verifyQuote(`Don’t ship on Fridays unless the “release” label is set`, src)).toBe(src[0]);
    const curlySrc = [`Don’t ship on Fridays unless the “release” label is set.`];
    expect(verifyQuote(`don't ship on fridays unless the "release" label is set.`, curlySrc)).toBe(curlySrc[0]);
  });

  it("matches a contiguous fragment at least minLen long", () => {
    expect(verifyQuote("the public API or the SDK interfaces", sources)).toBe(R1);
  });

  it("rejects invented text", () => {
    expect(verifyQuote("Changes to the private API are mine to decide.", sources)).toBe("");
    expect(verifyQuote("Anything that spends more than $500 a month comes to me.", sources)).toBe("");
  });

  it("rejects fragments shorter than minLen even when they occur", () => {
    expect(verifyQuote("to decide", sources)).toBe(""); // 9 characters, occurs in R1
    expect(verifyQuote("", sources)).toBe("");
    // 12 characters is the default minimum: exactly 12 passes.
    const twelve = "mine to deci";
    expect(normalizeQuote(twelve)).toHaveLength(12);
    expect(verifyQuote(twelve, sources)).toBe(R1);
    expect(verifyQuote("ine to deci", sources)).toBe("");
  });
});

describe("enforceSettleInvariant", () => {
  const settleOn = (id: string, option: string, clearing: string) => {
    const d = decision(id);
    return { d, out: routeOutput(d, { route: "settle", settle_option: option, clearing_rule: clearing }) };
  };

  it("settles when the option is reversible, cheap, and cleared by a current rule (branch-cleanup)", () => {
    const { d, out } = settleOn("branch-cleanup", "A", R2);
    expect(enforceSettleInvariant(out, d, rules)).toEqual({ route: "settle", settle_option: "A" });
  });

  it("accepts a lightly reformatted clearing rule", () => {
    const { d, out } = settleOn("branch-cleanup", "A", R2.toUpperCase().replace(/\.$/, ""));
    expect(enforceSettleInvariant(out, d, rules).route).toBe("settle");
  });

  it("passes non-settle routes through untouched", () => {
    const d = decision("api-rename");
    expect(enforceSettleInvariant(routeOutput(d, { route: "decide" }), d, rules)).toEqual({ route: "decide", settle_option: "" });
    expect(enforceSettleInvariant(routeOutput(d, { route: "check_in" }), d, rules)).toEqual({ route: "check_in", settle_option: "" });
  });

  it("downgrades when the option can't be fully undone (onsite-flight is partly reversible and costs money)", () => {
    const { d, out } = settleOn("onsite-flight", "A", rule("R12").text);
    const r = enforceSettleInvariant(out, d, rules);
    expect(r.route).toBe("check_in");
    expect(r.settle_option).toBe("");
    expect(r.adjusted).toMatch(/can't be fully undone/);
    expect(r.adjusted).toContain(`it costs $${d.bounds.A.cost_usd}`);
    expect(r.adjusted).not.toMatch(/no written rule/);
  });

  it("downgrades on reversibility alone (flaky-test B: delete the test, partly reversible, free)", () => {
    const { d, out } = settleOn("flaky-test", "B", R2);
    expect(d.bounds.B).toEqual({ reversible: "partly", cost_usd: 0 });
    const r = enforceSettleInvariant(out, d, rules);
    expect(r.route).toBe("check_in");
    expect(r.adjusted).toMatch(/can't be fully undone/);
    expect(r.adjusted).not.toMatch(/costs/);
    expect(r.adjusted).not.toMatch(/no written rule/);
  });

  it("downgrades on cost alone (ci-runners A: reversible but over the ceiling)", () => {
    const { d, out } = settleOn("ci-runners", "A", rule("R3").text);
    expect(d.bounds.A.reversible).toBe("yes");
    expect(d.bounds.A.cost_usd).toBeGreaterThan(SETTLE_MAX_COST_USD);
    const r = enforceSettleInvariant(out, d, rules);
    expect(r.route).toBe("check_in");
    expect(r.adjusted).toContain(`it costs $${d.bounds.A.cost_usd}`);
    expect(r.adjusted).not.toMatch(/undone/);
    expect(r.adjusted).not.toMatch(/no written rule/);
  });

  it("settles at exactly the cost ceiling and not a cent over", () => {
    const at = decision("branch-cleanup");
    at.bounds.A = { reversible: "yes", cost_usd: SETTLE_MAX_COST_USD };
    const out = routeOutput(at, { route: "settle", settle_option: "A", clearing_rule: R2 });
    expect(enforceSettleInvariant(out, at, rules).route).toBe("settle");
    at.bounds.A = { reversible: "yes", cost_usd: SETTLE_MAX_COST_USD + 0.01 };
    expect(enforceSettleInvariant(out, at, rules).route).toBe("check_in");
  });

  it("downgrades when no clearing rule is given", () => {
    const { d, out } = settleOn("branch-cleanup", "A", "");
    const r = enforceSettleInvariant(out, d, rules);
    expect(r.route).toBe("check_in");
    expect(r.adjusted).toMatch(/no written rule clears it/);
  });

  it("downgrades when the clearing rule is invented", () => {
    const { d, out } = settleOn("branch-cleanup", "A", "Deleting old branches is always fine; just do it.");
    expect(enforceSettleInvariant(out, d, rules).adjusted).toMatch(/no written rule clears it/);
  });

  it("downgrades when the clearing rule was edited away", () => {
    const edited: Rule[] = rules.map((r) =>
      r.id === "R2" ? { ...r, text: "Housekeeping in our own repos comes to me for now." } : r,
    );
    const { d, out } = settleOn("branch-cleanup", "A", R2);
    const r = enforceSettleInvariant(out, d, edited);
    expect(r.route).toBe("check_in");
    expect(r.adjusted).toMatch(/no written rule clears it/);
    // The same output still settles under the unedited rules.
    expect(enforceSettleInvariant(out, d, rules).route).toBe("settle");
  });

  it("downgrades when the picked option has no hand-authored bounds", () => {
    const d = decision("branch-cleanup");
    delete (d.bounds as Record<string, unknown>).A;
    const out = routeOutput(d, { route: "settle", settle_option: "A", clearing_rule: R2 });
    expect(enforceSettleInvariant(out, d, rules).adjusted).toMatch(/has no bounds/);
  });

  it("names every missing condition at once", () => {
    const { d, out } = settleOn("onsite-flight", "B", "");
    const r = enforceSettleInvariant(out, d, rules);
    expect(r.adjusted).toMatch(/can't be fully undone/);
    expect(r.adjusted).toMatch(/it costs \$392/);
    expect(r.adjusted).toMatch(/no written rule clears it/);
  });
});

describe("verifiedQuotes", () => {
  it("keeps faithful quotes and drops invented ones", () => {
    const d = decision("sdk-dependency");
    const out = routeOutput(d, {
      clearing_rule: "Invented: dependencies are fine.",
      rule_quoted: R1.toLowerCase(),
      fact_quoted: facts[0].text,
    });
    expect(verifiedQuotes(out, rules, facts)).toEqual({ clearing_rule: "", rule_quoted: R1, fact_quoted: facts[0].text });
  });

  it("does not accept a fact as a rule quote or a rule as a fact quote", () => {
    const d = decision("sdk-dependency");
    const out = routeOutput(d, { rule_quoted: facts[0].text, fact_quoted: R1 });
    expect(verifiedQuotes(out, rules, facts)).toEqual({ clearing_rule: "", rule_quoted: "", fact_quoted: "" });
  });
});
