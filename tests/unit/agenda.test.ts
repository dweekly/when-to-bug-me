// src/shared/agenda.ts: the agenda is code. Which decisions reach the person, grouped by project,
// in what order, with the reasons and time estimates the page prints.

import { describe, expect, it } from "vitest";
import { buildAgenda } from "../../src/shared/agenda";
import { MINUTES_PER_CHECK_IN, MINUTES_PER_DECISION } from "../../src/shared/constants";
import { fakeRoute } from "../../src/shared/fakeModel";
import { enforceSettleInvariant } from "../../src/shared/route";
import type { Decision, Project, RouteKind } from "../../src/shared/types";
import { decisions, facts, persona, rules } from "./helpers";

/** The routes the page would show on first load with the fake model: fake route, then the invariant. */
function defaultRoutes(): Record<string, RouteKind> {
  return Object.fromEntries(decisions.map((d) => [d.id, enforceSettleInvariant(fakeRoute(d, rules, facts), d, rules).route]));
}

const byId = new Map(decisions.map((d) => [d.id, d]));

/** The priority order the agenda promises within a section. */
function inPriorityOrder(ids: string[]): boolean {
  for (let i = 1; i < ids.length; i++) {
    const a = byId.get(ids[i - 1])!;
    const b = byId.get(ids[i])!;
    const cmp = b.unblocks - a.unblocks || b.waiting_minutes - a.waiting_minutes || a.id.localeCompare(b.id);
    if (cmp > 0) return false;
  }
  return true;
}

/** Deterministic shuffle (mulberry32), so a failure reproduces. */
function shuffled<T>(xs: T[], seed: number): T[] {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function synthetic(id: string, project: string, unblocks: number, waiting: number): Decision {
  return {
    id,
    category: "Project planning",
    project,
    agent: ["main"],
    waiting_minutes: waiting,
    unblocks,
    question: `${id}?`,
    options: [
      { key: "A", label: "Yes" },
      { key: "B", label: "No" },
    ],
    recommended: "A",
    context: "",
    bounds: { A: { reversible: "yes", cost_usd: 0 }, B: { reversible: "yes", cost_usd: 0 } },
    tags: [],
  };
}

describe("buildAgenda with the fixture fleet", () => {
  const routes = defaultRoutes();
  const agenda = buildAgenda(decisions, routes, persona.projects);
  const inSections = agenda.sections.flatMap((s) => [...s.decisions, ...s.check_ins].map((i) => i.id));

  it("has at least one settled decision and one of each other route (so the checks below can fail)", () => {
    const kinds = new Set(Object.values(routes));
    expect(kinds).toEqual(new Set(["settle", "check_in", "decide"]));
  });

  it("never puts a settled decision in a section", () => {
    const settled = decisions.filter((d) => routes[d.id] === "settle").map((d) => d.id);
    for (const id of settled) expect(inSections).not.toContain(id);
    expect(new Set(agenda.settled)).toEqual(new Set(settled));
  });

  it("lists settled decisions longest-waiting first", () => {
    const waits = agenda.settled.map((id) => byId.get(id)!.waiting_minutes);
    expect(waits).toEqual([...waits].sort((a, b) => b - a));
  });

  it("puts every waiting, unsettled decision in exactly one section, under its own project", () => {
    const waiting = decisions.filter((d) => routes[d.id] !== "settle").map((d) => d.id);
    expect([...inSections].sort()).toEqual([...waiting].sort());
    for (const s of agenda.sections) {
      for (const i of [...s.decisions, ...s.check_ins]) expect(byId.get(i.id)!.project).toBe(s.project.id);
    }
  });

  it("puts decisions before check-ins, each list ordered by unblocks, then waiting, then id", () => {
    for (const s of agenda.sections) {
      expect(s.decisions.every((i) => i.route === "decide" && routes[i.id] === "decide")).toBe(true);
      expect(s.check_ins.every((i) => i.route === "check_in" && routes[i.id] === "check_in")).toBe(true);
      expect(inPriorityOrder(s.decisions.map((i) => i.id))).toBe(true);
      expect(inPriorityOrder(s.check_ins.map((i) => i.id))).toBe(true);
    }
  });

  it("marks only the first item of each section as first", () => {
    for (const s of agenda.sections) {
      const items = [...s.decisions, ...s.check_ins];
      expect(items[0].order_reason.startsWith("First here: ")).toBe(true);
      for (const i of items.slice(1)) expect(i.order_reason.startsWith("First here")).toBe(false);
    }
  });

  it("orders sections by total agents unblocked, and the section total is the sum", () => {
    for (const s of agenda.sections) {
      const sum = [...s.decisions, ...s.check_ins].reduce((n, i) => n + byId.get(i.id)!.unblocks, 0);
      expect(s.unblocks).toBe(sum);
    }
    const totals = agenda.sections.map((s) => s.unblocks);
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
    expect(agenda.sections[0].section_reason).toMatch(/^First, because answers here unblock/);
    for (const s of agenda.sections.slice(1)) expect(s.section_reason).toMatch(/^Next: answers here unblock/);
  });

  it("leaves out answered decisions", () => {
    const answered = new Set(["api-rename", "onsite-flight", "incident-action-items"]);
    const a = buildAgenda(decisions, routes, persona.projects, answered);
    const ids = a.sections.flatMap((s) => [...s.decisions, ...s.check_ins].map((i) => i.id));
    for (const id of answered) expect(ids).not.toContain(id);
    expect(ids).toHaveLength(inSections.length - answered.size);
  });

  it("is deterministic for shuffled decisions and projects", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const again = buildAgenda(shuffled(decisions, seed), routes, shuffled(persona.projects, seed * 7));
      expect(again).toEqual(agenda);
    }
  });

  it("computes minutes from the constants and names them in the heading", () => {
    for (const s of agenda.sections) {
      expect(s.minutes).toBe(s.decisions.length * MINUTES_PER_DECISION + s.check_ins.length * MINUTES_PER_CHECK_IN);
      expect(s.heading).toContain(`about ${s.minutes} minute`);
      expect(s.heading.startsWith(`${s.project.name}: `)).toBe(true);
    }
  });
});

describe("buildAgenda with hand-built decisions", () => {
  const projects: Project[] = [
    { id: "p1", name: "Alpha", blurb: "" },
    { id: "p2", name: "Beta", blurb: "" },
  ];

  it("breaks ties within a section by waiting time, then by id", () => {
    const ds = [synthetic("c", "p1", 2, 10), synthetic("b", "p1", 2, 10), synthetic("a", "p1", 2, 5), synthetic("d", "p1", 3, 1)];
    const routes = Object.fromEntries(ds.map((d) => [d.id, "decide" as RouteKind]));
    const a = buildAgenda(ds, routes, projects);
    expect(a.sections[0].decisions.map((i) => i.id)).toEqual(["d", "b", "c", "a"]);
  });

  it("orders sections with equal unblocks by their longest wait", () => {
    const ds = [synthetic("x", "p1", 1, 30), synthetic("y", "p2", 1, 90)];
    const routes: Record<string, RouteKind> = { x: "check_in", y: "check_in" };
    expect(buildAgenda(ds, routes, projects).sections.map((s) => s.project.id)).toEqual(["p2", "p1"]);
  });

  it("writes the heading from the constants", () => {
    const ds = [synthetic("a", "p1", 1, 1), synthetic("b", "p1", 1, 2), synthetic("c", "p1", 1, 3)];
    const routes: Record<string, RouteKind> = { a: "decide", b: "decide", c: "check_in" };
    const s = buildAgenda(ds, routes, projects).sections[0];
    const minutes = 2 * MINUTES_PER_DECISION + 1 * MINUTES_PER_CHECK_IN;
    expect(s.minutes).toBe(minutes);
    expect(s.heading).toBe(`Alpha: two decisions and one quick check-in, about ${minutes} minute${minutes === 1 ? "" : "s"}`);
  });

  it("drops a project whose decisions are all settled or answered, and skips unrouted decisions", () => {
    const ds = [synthetic("a", "p1", 5, 1), synthetic("b", "p2", 1, 1), synthetic("c", "p2", 9, 1)];
    const routes: Record<string, RouteKind> = { a: "settle", b: "check_in" }; // c has no route yet
    const a = buildAgenda(ds, routes, projects);
    expect(a.sections.map((s) => s.project.id)).toEqual(["p2"]);
    expect(a.sections[0].check_ins.map((i) => i.id)).toEqual(["b"]);
    expect(a.settled).toEqual(["a"]);
  });
});
