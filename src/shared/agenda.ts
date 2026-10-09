// The agenda is code, not model output: which decisions reach the person, in what order, and how
// they are grouped. Every ordering choice produces a reason the page prints.

import { MINUTES_PER_CHECK_IN, MINUTES_PER_DECISION } from "./constants";
import type { Decision, Project, RouteKind } from "./types";

export interface AgendaItem {
  id: string;
  route: Exclude<RouteKind, "settle">;
  /** Why it sits where it does, in plain words. */
  order_reason: string;
}

export interface AgendaSection {
  project: Project;
  /** Substantive decisions first, then the batched quick check-ins. */
  decisions: AgendaItem[];
  check_ins: AgendaItem[];
  unblocks: number;
  minutes: number;
  /** The line that names this change of project, e.g. "Three decisions on Launch, about 8 minutes." */
  heading: string;
  section_reason: string;
}

export interface Agenda {
  sections: AgendaSection[];
  /** Ids Bug Me settled alone, oldest waiting first. */
  settled: string[];
}

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
function count(n: number, noun: string): string {
  const word = n < WORDS.length ? WORDS[n] : String(n);
  return `${word} ${noun}${n === 1 ? "" : "s"}`;
}

function hours(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.round(minutes / 6) / 10;
  return `${h} h`;
}

/** The one time estimate used everywhere (home, sections, interstitials, explainer). Heuristic constants. */
export function estimateMinutes(decisions: number, checkIns: number): number {
  return decisions * MINUTES_PER_DECISION + checkIns * MINUTES_PER_CHECK_IN;
}

/** Overnight totals by effective route (after the code invariant), regardless of what has been done since. */
export function overnightTotals(routes: Record<string, RouteKind>): { settle: number; check_in: number; decide: number; minutes: number } {
  const t = { settle: 0, check_in: 0, decide: 0 };
  for (const r of Object.values(routes)) t[r]++;
  return { ...t, minutes: estimateMinutes(t.decide, t.check_in) };
}

/**
 * The next decision in a focus session: finish the current project's active items before moving on,
 * then take the next project in agenda order. Returns the id and whether the project changed.
 */
export function nextInSession(agenda: Agenda, currentProject: string | null): { id: string | null; changedProject: boolean; project: string | null } {
  const items = (s: AgendaSection) => [...s.decisions, ...s.check_ins];
  const same = agenda.sections.find((s) => s.project.id === currentProject);
  if (same && items(same).length) return { id: items(same)[0].id, changedProject: false, project: same.project.id };
  const nextSection = agenda.sections.find((s) => items(s).length);
  if (!nextSection) return { id: null, changedProject: currentProject !== null, project: null };
  return { id: items(nextSection)[0].id, changedProject: currentProject !== null && nextSection.project.id !== currentProject, project: nextSection.project.id };
}

/** Within a section: most agents unblocked first, then longest waiting, then id for a stable order. */
function byPriority(a: Decision, b: Decision): number {
  return b.unblocks - a.unblocks || b.waiting_minutes - a.waiting_minutes || a.id.localeCompare(b.id);
}

function itemReason(d: Decision, rank: number): string {
  const unblocks = d.unblocks > 0 ? `unblocks ${count(d.unblocks, "agent").toLowerCase()}` : "blocks no other agents";
  return `${rank === 0 ? "First here: " : ""}${unblocks}; waiting ${hours(d.waiting_minutes)}`;
}

/**
 * Build the agenda from the routes. Projects come in order of how many agents their waiting answers
 * unblock, then by their longest wait, then by id. Settled decisions never appear in a section.
 */
export function buildAgenda(
  decisions: Decision[],
  routes: Record<string, RouteKind>,
  projects: Project[],
  /** Decisions already answered this session; they leave the agenda. */
  done: Set<string> = new Set(),
  /** Decisions the person set aside ("Not now"); listed separately, never in a section. */
  aside: Set<string> = new Set(),
): Agenda {
  const waiting = decisions.filter((d) => !done.has(d.id) && !aside.has(d.id) && routes[d.id] && routes[d.id] !== "settle");
  const settled = decisions
    .filter((d) => routes[d.id] === "settle" && !aside.has(d.id))
    .sort((a, b) => b.waiting_minutes - a.waiting_minutes || a.id.localeCompare(b.id))
    .map((d) => d.id);

  const sections: AgendaSection[] = [];
  for (const project of projects) {
    const mine = waiting.filter((d) => d.project === project.id);
    if (mine.length === 0) continue;
    const decide = mine.filter((d) => routes[d.id] === "decide").sort(byPriority);
    const quick = mine.filter((d) => routes[d.id] === "check_in").sort(byPriority);
    const unblocks = mine.reduce((s, d) => s + d.unblocks, 0);
    const minutes = estimateMinutes(decide.length, quick.length);
    const parts = [];
    if (decide.length) parts.push(count(decide.length, "decision").toLowerCase());
    if (quick.length) parts.push(count(quick.length, "quick check-in").toLowerCase());
    const heading = `${project.name}: ${parts.join(" and ")}, about ${minutes} minute${minutes === 1 ? "" : "s"}`;
    sections.push({
      project,
      decisions: decide.map((d, i) => ({ id: d.id, route: "decide", order_reason: itemReason(d, i) })),
      check_ins: quick.map((d, i) => ({ id: d.id, route: "check_in", order_reason: itemReason(d, decide.length + i) })),
      unblocks,
      minutes,
      heading,
      section_reason: "",
    });
  }
  const longest = (s: AgendaSection) =>
    Math.max(...[...s.decisions, ...s.check_ins].map((i) => decisions.find((d) => d.id === i.id)!.waiting_minutes));
  sections.sort((a, b) => b.unblocks - a.unblocks || longest(b) - longest(a) || a.project.id.localeCompare(b.project.id));
  sections.forEach((s, i) => {
    const agents = count(s.unblocks, "agent").toLowerCase();
    s.section_reason =
      i === 0
        ? `First, because answers here unblock ${agents}, the most of any project.`
        : `Next: answers here unblock ${agents}.`;
  });
  return { sections, settled };
}
