// Reflection prompts (docs/STAGE-10.md, 10c): break thresholds from constants, the feedback cadence and
// its persistence rules, and the weekly-review numbers taken from the record only.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BREAK_AFTER_EST_MINUTES, FEEDBACK_EVERY_TRANSITIONS, MINUTES_PER_CHECK_IN, MINUTES_PER_DECISION } from "../../src/shared/constants";
import { type RecordLike, SYNTHETIC_STATED_PRIORITIES, type Transition, answerMinutes, estimatedMinutesSince, launchCounts, planTransition, reviewOf } from "../../src/shared/reflection";
import { routePrompt } from "../../src/shared/prompts";
import { decisions, facts, persona, rules } from "./helpers";

const PROJECT: Record<string, string> = { a1: "launch", a2: "launch", a3: "launch", b1: "billing", b2: "billing", p1: "platform", p2: "platform" };
const projectOf = (id: string) => PROJECT[id];
const answer = (id: string, route: "decide" | "check_in"): RecordLike => ({ kind: "answer", id, route, at: "x" });

/** Press Next out of `from`, applying the plan as the page does. */
function next(transitions: Transition[], record: RecordLike[], from: string, to: string | null): Transition | null {
  const t = planTransition({ transitions, record, from, to, projectOf, at: "2026-10-14T09:00:00Z" });
  if (t) {
    transitions.push(t);
    record.push({ kind: "transition", transition: t.id });
  }
  return t;
}

describe("estimated minutes", () => {
  it("weights each answer by the route it was answered on, from the constants", () => {
    expect(answerMinutes("decide")).toBe(MINUTES_PER_DECISION);
    expect(answerMinutes("check_in")).toBe(MINUTES_PER_CHECK_IN);
    const rec = [answer("a1", "decide"), { kind: "turn" }, answer("a2", "check_in"), answer("a3", "decide")];
    expect(estimatedMinutesSince(rec, 0)).toBe(2 * MINUTES_PER_DECISION + MINUTES_PER_CHECK_IN);
    expect(estimatedMinutesSince(rec, 2)).toBe(MINUTES_PER_CHECK_IN + MINUTES_PER_DECISION);
  });
});

describe("the break", () => {
  it("is offered once the stretch reaches the threshold, not before", () => {
    const decidesToThreshold = Math.ceil(BREAK_AFTER_EST_MINUTES / MINUTES_PER_DECISION);
    const short: RecordLike[] = Array.from({ length: decidesToThreshold - 1 }, (_, i) => answer(`a${i}`, "decide"));
    expect(planTransition({ transitions: [], record: short, from: "launch", to: "billing", projectOf, at: "" })!.breakOffered).toBe((decidesToThreshold - 1) * MINUTES_PER_DECISION >= BREAK_AFTER_EST_MINUTES);
    const long = [...short, answer("a9", "decide")];
    const t = planTransition({ transitions: [], record: long, from: "launch", to: "billing", projectOf, at: "" })!;
    expect(t.breakOffered).toBe(true);
    expect(t.stretch_minutes_est).toBe(decidesToThreshold * MINUTES_PER_DECISION);
  });

  it("counts the stretch from the last suggestion, so it doesn't repeat right away", () => {
    const transitions: Transition[] = [];
    const record: RecordLike[] = [answer("a1", "decide"), answer("a2", "decide"), answer("a3", "decide"), answer("b0", "decide")];
    expect(next(transitions, record, "launch", "billing")!.breakOffered).toBe(true);
    record.push(answer("b1", "check_in"));
    const second = next(transitions, record, "billing", "platform")!;
    expect(second.stretch_minutes_est).toBe(MINUTES_PER_CHECK_IN);
    expect(second.breakOffered).toBe(false);
  });

  it("check-ins alone take longer to add up than decisions", () => {
    const record = Array.from({ length: 4 }, (_, i) => answer(`c${i}`, "check_in"));
    expect(planTransition({ transitions: [], record, from: "launch", to: null, projectOf, at: "" })!.breakOffered).toBe(4 * MINUTES_PER_CHECK_IN >= BREAK_AFTER_EST_MINUTES);
  });
});

describe("were those worth your time?", () => {
  it("is asked on the first change of project and then at most every FEEDBACK_EVERY_TRANSITIONS", () => {
    const transitions: Transition[] = [];
    const record: RecordLike[] = [];
    const asked: boolean[] = [];
    const projects = ["launch", "billing", "platform"];
    for (let i = 0; i < 7; i++) {
      const from = projects[i % 3];
      record.push(answer(Object.keys(PROJECT).find((id) => PROJECT[id] === from)!, "check_in"));
      asked.push(next(transitions, record, from, projects[(i + 1) % 3])!.feedbackAsked);
    }
    const expected = Array.from({ length: 7 }, (_, i) => i % FEEDBACK_EVERY_TRANSITIONS === 0);
    expect(asked).toEqual(expected);
    expect(transitions.map((t) => t.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("covers only the finished project's decisions answered since the previous change", () => {
    const transitions: Transition[] = [];
    const record: RecordLike[] = [answer("p1", "check_in"), answer("a1", "decide"), answer("a2", "decide")];
    expect(next(transitions, record, "launch", "billing")!.covered).toEqual(["a1", "a2"]);
    record.push(answer("a3", "decide"), answer("b1", "decide"));
    expect(next(transitions, record, "billing", null)!.covered).toEqual(["b1"]);
  });

  it("isn't asked about a project with nothing answered, and the next change is then eligible", () => {
    const transitions: Transition[] = [];
    const record: RecordLike[] = [];
    expect(next(transitions, record, "launch", "billing")!.feedbackAsked).toBe(false);
    record.push(answer("b1", "decide"));
    expect(next(transitions, record, "billing", "platform")!.feedbackAsked).toBe(true);
  });

  it("a second press of the same Next, with nothing answered since, counts nothing", () => {
    const transitions: Transition[] = [];
    const record: RecordLike[] = [answer("a1", "decide")];
    expect(next(transitions, record, "launch", "billing")).not.toBeNull();
    expect(next(transitions, record, "launch", "billing")).toBeNull();
    expect(transitions).toHaveLength(1);
  });
});

describe("the weekly-review sketch", () => {
  const projects = persona.projects;

  it("takes time and counts from the answer events' own routes, once per decision, in the stated order", () => {
    const record: RecordLike[] = [
      answer("a1", "decide"),
      answer("a2", "check_in"),
      answer("a1", "decide"), // a duplicate answer event must not count twice
      answer("b1", "check_in"),
      { kind: "rerouted", id: "a3", from: "decide", to: "settle" },
    ];
    const r = reviewOf({ record, projectOf, projects, priorities: SYNTHETIC_STATED_PRIORITIES });
    expect(r.projects.map((p) => p.id)).toEqual([...SYNTHETIC_STATED_PRIORITIES]);
    expect(r.projects.map((p) => p.rank)).toEqual([1, 2, 3]);
    const launch = r.projects.find((p) => p.id === "launch")!;
    expect(launch).toMatchObject({ decided: 1, checked: 1, minutes_est: MINUTES_PER_DECISION + MINUTES_PER_CHECK_IN });
    expect(r.asked).toEqual({ decide: 1, check_in: 2 });
    expect(r.top?.id).toBe("launch");
  });

  it("with no stated priorities (the owner's page), keeps the projects' order and shows no ranks", () => {
    const r = reviewOf({ record: [], projectOf, projects, priorities: null });
    expect(r.projects.map((p) => p.id)).toEqual(projects.map((p) => p.id));
    expect(r.projects.every((p) => p.rank === null)).toBe(true);
    expect(r.top).toBeNull();
  });

  it("sums measured attention per project and overall, ignoring malformed stretches", () => {
    const launchId = "a1";
    const billingId = "b1";
    const record: RecordLike[] = [
      { kind: "attention", id: launchId, seconds: 40 },
      { kind: "attention", id: launchId, seconds: 25 },
      { kind: "attention", id: billingId, seconds: 30 },
      { kind: "attention", id: billingId, seconds: -5 },
      { kind: "attention", id: billingId, seconds: "lots" },
      { kind: "attention", seconds: 99 },
    ];
    const r = reviewOf({ record, projectOf, projects, priorities: null });
    expect(r.measured).toEqual({ seconds: 95, decisions: 2 });
    expect(r.projects.find((p) => p.id === "launch")!.seconds_measured).toBe(65);
    expect(r.projects.find((p) => p.id === "billing")!.seconds_measured).toBe(30);
  });

  it("tallies one feedback tap per change of project", () => {
    const record: RecordLike[] = [
      { kind: "feedback", transition: "t1", choice: "all" },
      { kind: "feedback", transition: "t4", choice: "none" },
      { kind: "feedback", transition: "t4", choice: "none" },
      { kind: "feedback", transition: "t7", choice: "bogus" },
    ];
    expect(reviewOf({ record, projectOf, projects, priorities: null }).feedback).toEqual({ all: 1, some: 0, none: 1 });
  });

  it("puts Dispatch reports against the estimate, with a missing cost as null (shown 'not reported')", () => {
    const record: RecordLike[] = [
      { kind: "dispatch", brief: "b-1", headline: "Usage demo", estimate_minutes: 45 },
      { kind: "dispatch_report", brief: "b-1", headline: "Usage demo", estimate_minutes: 45, minutes: 38, cost_usd: null, outcome: "done", synthetic: true },
      { kind: "dispatch", brief: "b-2", headline: "PagerDuty", estimate_minutes: 90 },
      { kind: "dispatch_report", brief: "b-3", estimate_minutes: 30, minutes: 50, cost_usd: 1.25, outcome: "partial", synthetic: false },
    ];
    const d = reviewOf({ record, projectOf, projects, priorities: null }).dispatch;
    expect(d).toEqual([
      { brief: "b-1", headline: "Usage demo", estimate_minutes: 45, minutes: 38, cost_usd: null, outcome: "done", synthetic: true },
      { brief: "b-2", headline: "PagerDuty", estimate_minutes: 90, minutes: null, cost_usd: null, outcome: null, synthetic: false },
      { brief: "b-3", headline: "", estimate_minutes: 30, minutes: 50, cost_usd: 1.25, outcome: "partial", synthetic: false },
    ]);
  });
});

describe("the review's Dispatch rows, from round 1 of review", () => {
  it("leave out a copy the clipboard refused, and keep a report that has no start time", () => {
    const record: RecordLike[] = [
      { kind: "dispatch", brief: "refused", headline: "x", estimate_minutes: 20, copied: false },
      { kind: "dispatch_report", brief: "manual", headline: "Ran by hand", estimate_minutes: 30, minutes: null, cost_usd: 1.25, outcome: "done", synthetic: false },
    ];
    expect(reviewOf({ record, projectOf, projects: persona.projects, priorities: null }).dispatch).toEqual([
      { brief: "manual", headline: "Ran by hand", estimate_minutes: 30, minutes: null, cost_usd: 1.25, outcome: "done", synthetic: false },
    ]);
  });
});

describe("the synthetic stated priorities stay out of routing", () => {
  it("are not in the persona fixture, the prompts module, or a built route prompt", () => {
    expect(JSON.stringify(persona)).not.toMatch(/priorit/i);
    expect(readFileSync("src/shared/prompts.ts", "utf8")).not.toMatch(/reflection|STATED_PRIORITIES/);
    const prompt = routePrompt(persona, rules, facts, decisions[0]);
    expect(prompt).not.toMatch(/stated priorit/i);
  });
});

describe("what counts as sent", () => {
  it("a runner launch counts once it is running, not while starting or after failing", () => {
    expect(launchCounts({ state: "running" })).toBe(true);
    expect(launchCounts({ state: "launching" })).toBe(false);
    expect(launchCounts({ state: "failed" })).toBe(false);
    expect(launchCounts(undefined)).toBe(false);
  });
});
