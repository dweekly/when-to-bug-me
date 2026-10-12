// Stage 2 shared logic: precedence of standing facts, set-aside decisions in the agenda, the
// focus-session order, the one estimate, and "Skip" reasons.
import { describe, expect, it } from "vitest";
import { buildAgenda, estimateMinutes, nextInSession, overnightTotals } from "../../src/shared/agenda";
import { GLOW_START, GLOW_STEP, nextGlow } from "../../src/shared/lifecycle";
import { PUNT_KINDS, puntInstruction, puntProblem } from "../../src/shared/punt";
import { enforceSettleInvariant } from "../../src/shared/route";
import type { RouteKind } from "../../src/shared/types";
import { decision, decisions, facts, persona, routeOutput, rules } from "./helpers";

describe("precedence: a standing fact outranks a rule that would settle", () => {
  const d = decision("formatter-run");
  const settle = { route: "settle" as const, settle_option: "A", clearing_rule: rules.find((r) => r.id === "R2")!.text };
  it("settles when no fact is quoted", () => {
    expect(enforceSettleInvariant(routeOutput(d, settle), d, rules, facts).route).toBe("settle");
  });
  it("brings it to the person when a verified fact is quoted", () => {
    const r = enforceSettleInvariant(routeOutput(d, { ...settle, fact_quoted: facts[3].text }), d, rules, facts);
    expect(r.route).toBe("check_in");
    expect(r.adjusted).toMatch(/standing preferences/);
  });
  it("ignores an invented fact quote", () => {
    expect(enforceSettleInvariant(routeOutput(d, { ...settle, fact_quoted: "Jordan loves formatting." }), d, rules, facts).route).toBe("settle");
  });
});

describe("agenda with set-aside decisions", () => {
  const routes = Object.fromEntries(decisions.map((d) => [d.id, (d.id === "branch-cleanup" ? "settle" : d.unblocks > 1 ? "decide" : "check_in") as RouteKind]));
  it("never lists a set-aside decision in a section or as settled", () => {
    const a = buildAgenda(decisions, routes, persona.projects, new Set(), new Set(["api-rename", "branch-cleanup"]));
    const ids = a.sections.flatMap((s) => [...s.decisions, ...s.check_ins].map((i) => i.id));
    expect(ids).not.toContain("api-rename");
    expect(a.settled).not.toContain("branch-cleanup");
  });
  it("one estimate: totals and sections agree", () => {
    const t = overnightTotals(routes);
    const a = buildAgenda(decisions, routes, persona.projects);
    expect(a.sections.reduce((m, s) => m + s.minutes, 0)).toBe(t.minutes);
    expect(t.minutes).toBe(estimateMinutes(t.decide, t.check_in));
  });
  it("a focus session finishes the current project before moving on", () => {
    const a = buildAgenda(decisions, routes, persona.projects);
    const second = a.sections[1].project.id;
    const n = nextInSession(a, second);
    expect(n.project).toBe(second);
    expect(n.changedProject).toBe(false);
    const empty = buildAgenda(decisions, routes, persona.projects, new Set(decisions.filter((d) => d.project === second).map((d) => d.id)));
    expect(nextInSession(empty, second).changedProject).toBe(true);
  });
});

describe("Skip", () => {
  it("needs a kind and a real sentence", () => {
    expect(puntProblem(null, "anything at all")).toMatch(/Pick/);
    expect(puntProblem("input", "hmm")).toBe("Whose input, and on what?");
    expect(puntProblem("input", "Priya, on whether finance can absorb it")).toBe("");
  });
  it("tells the agent exactly what to gather, in its terms", () => {
    for (const k of PUNT_KINDS) expect(puntInstruction(k.kind, "  the Q3  volume forecast ", "Jordan")).toMatch(/Jordan .*the Q3 volume forecast$/);
  });
  it("a reasoned punt brightens the glow", () => {
    expect(nextGlow(GLOW_START, { kind: "punted" })).toBeCloseTo(GLOW_START + GLOW_STEP.basis);
  });
});
