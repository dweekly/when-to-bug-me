// src/shared/fakeModel.ts: the deterministic stand-in the e2e suite runs against. These pin the
// behaviours the canonical demo path depends on (build plan, "Intent" and the e2e acceptance line).

import { describe, expect, it } from "vitest";
import { WHY_THRESHOLD } from "../../src/shared/constants";
import { fakeFact, fakeRoute } from "../../src/shared/fakeModel";
import { topGuess } from "../../src/shared/lifecycle";
import { enforceSettleInvariant, parseRouteOutput, verifiedQuotes } from "../../src/shared/route";
import type { Fact } from "../../src/shared/types";
import { decision, decisions, facts, rules } from "./helpers";

const DROP_OFF = "I do school drop-off, so nothing before 8:30 in the morning.";

function routed(id: string, fs: Fact[] = facts) {
  const d = decision(id);
  const out = fakeRoute(d, rules, fs);
  return { d, out, final: enforceSettleInvariant(out, d, rules) };
}

describe("fakeRoute", () => {
  it("returns output that parseRouteOutput accepts for every fixture decision", () => {
    for (const d of decisions) {
      expect(() => parseRouteOutput(fakeRoute(d, rules, facts), d), d.id).not.toThrow();
    }
  });

  it("routes onsite-flight as a check-in, guessing the recommended option at or above the why threshold", () => {
    const { d, out, final } = routed("onsite-flight");
    expect(final.route).toBe("check_in");
    const top = topGuess(out.guess);
    expect(top.option).toBe(d.recommended);
    expect(top.p).toBeGreaterThanOrEqual(WHY_THRESHOLD);
  });

  it("settles berlin-sync under the default rules and facts", () => {
    expect(routed("berlin-sync").final.route).toBe("settle");
  });

  it("re-routes berlin-sync from settle to check_in after the drop-off fact, quoting it", () => {
    const flight = decision("onsite-flight");
    const proposed = fakeFact(flight, DROP_OFF, decisions, facts);
    expect(proposed.kind).toBe("add");
    expect(proposed.may_affect).toContain("berlin-sync");
    const withFact: Fact[] = [...facts, { id: "F5", text: proposed.text, source: "test", scope: proposed.scope }];

    const { out, final } = routed("berlin-sync", withFact);
    expect(final.route).toBe("check_in");
    expect(out.fact_quoted).toBe(proposed.text);
    expect(verifiedQuotes(out, rules, withFact).fact_quoted).toBe(proposed.text);
    expect(topGuess(out.guess).option).toBe("B");
  });

  it("leaves an unrelated settled decision (formatter-run) unchanged by the drop-off fact", () => {
    const withFact: Fact[] = [...facts, { id: "F5", text: "No commitments before 8:30am: Jordan does school drop-off.", source: "test", scope: "all" }];
    expect(routed("formatter-run", withFact)).toEqual(routed("formatter-run"));
    expect(routed("formatter-run").final.route).toBe("settle");
  });
});

describe("fakeFact", () => {
  it("returns kind none for 'just this once'", () => {
    const out = fakeFact(decision("onsite-flight"), "Just this once, the later one is fine.", decisions, facts);
    expect(out.kind).toBe("none");
    expect(out.text).toBe("");
    expect(out.may_affect).toEqual([]);
  });

  it("never lists the source decision among the ones it may affect", () => {
    const out = fakeFact(decision("onsite-flight"), DROP_OFF, decisions, facts);
    expect(out.may_affect).not.toContain("onsite-flight");
  });
});
