// Reflection prompts (docs/STAGE-10.md, 10c): a break suggested after a demanding stretch, "were those
// worth your time?" now and then, and the numbers behind the weekly-review sketch. Plain code over the
// record; no model. Every minute here is ESTIMATED from the route a decision was answered on
// (MINUTES_PER_DECISION, MINUTES_PER_CHECK_IN), never measured, and the page labels it so.

import { BREAK_AFTER_EST_MINUTES, FEEDBACK_EVERY_TRANSITIONS, MINUTES_PER_CHECK_IN, MINUTES_PER_DECISION } from "./constants";

/**
 * Jordan's stated priorities, most important first. SYNTHETIC: written by hand for the demo, like the
 * rest of the persona. Kept here, outside fixtures/persona.json and every prompt, so the routing
 * prompts (and so every recorded run's key) are unchanged; only the review sketch reads it.
 */
export const SYNTHETIC_STATED_PRIORITIES: readonly string[] = ["billing", "launch", "platform"];

export type FeedbackChoice = "all" | "some" | "none";

/** The three taps, as symbols the app already uses: ● needed you, ◐ some should have been settled, ○ none did. */
export const FEEDBACK_CHOICES: { key: FeedbackChoice; glyph: string; label: string }[] = [
  { key: "all", glyph: "●", label: "All worth it" },
  { key: "some", glyph: "◐", label: "Some should have been settled" },
  { key: "none", glyph: "○", label: "None needed me" },
];

/** One completed change of project, counted when the person presses Next out of a finished project. */
export interface Transition {
  /** Stable within a morning: "t1", "t2"... */
  id: string;
  /** 1-based count of changes of project this morning. */
  n: number;
  at: string;
  from: string;
  /** The project Next leads to, or null when nothing is left. */
  to: string | null;
  /** The record's length when it happened: answers after this index belong to later stretches. */
  recordIndex: number;
  /** Decisions in `from` answered since the previous change of project: what "those" means. */
  covered: string[];
  /** Estimated minutes of answers since the last break suggestion (or the start of the morning). */
  stretch_minutes_est: number;
  breakOffered: boolean;
  breakDismissed?: boolean;
  feedbackAsked: boolean;
  feedback?: FeedbackChoice;
  feedbackDismissed?: boolean;
}

/** The fields of a record event this module reads. */
export interface RecordLike {
  kind: string;
  id?: string;
  [k: string]: unknown;
}

/** Estimated minutes one answer cost, by the route it was answered on. */
export function answerMinutes(route: unknown): number {
  return route === "decide" ? MINUTES_PER_DECISION : MINUTES_PER_CHECK_IN;
}

/** Estimated minutes of answers in the record from `fromIndex` on. */
export function estimatedMinutesSince(record: RecordLike[], fromIndex: number): number {
  return record.slice(fromIndex).reduce((m, r) => (r.kind === "answer" ? m + answerMinutes(r.route) : m), 0);
}

/**
 * The change of project the person just made by pressing Next out of `from`, or null when it repeats the
 * last one (a second press of the same Next, with nothing answered since). Whether to suggest a break
 * and whether to ask for feedback are decided here, once, so reloading or going Back never re-decides.
 */
export function planTransition(input: {
  transitions: Transition[];
  record: RecordLike[];
  from: string;
  to: string | null;
  projectOf: (id: string) => string | undefined;
  at: string;
}): Transition | null {
  const { transitions, record, from, to, projectOf, at } = input;
  const last = transitions[transitions.length - 1];
  if (last && last.from === from && !record.slice(last.recordIndex).some((r) => r.kind === "answer")) return null;
  const n = transitions.length + 1;
  const lastBreak = [...transitions].reverse().find((t) => t.breakOffered);
  const stretch = estimatedMinutesSince(record, lastBreak?.recordIndex ?? 0);
  const covered = [...new Set(record.slice(last?.recordIndex ?? 0).filter((r) => r.kind === "answer" && r.id && projectOf(r.id) === from).map((r) => r.id as string))];
  const lastAsked = [...transitions].reverse().find((t) => t.feedbackAsked);
  return {
    id: `t${n}`,
    n,
    at,
    from,
    to,
    recordIndex: record.length,
    covered,
    stretch_minutes_est: stretch,
    breakOffered: stretch >= BREAK_AFTER_EST_MINUTES,
    feedbackAsked: covered.length > 0 && (!lastAsked || n - lastAsked.n >= FEEDBACK_EVERY_TRANSITIONS),
  };
}

// ---------- The weekly-review sketch ----------

export interface ReviewProject {
  id: string;
  name: string;
  /** 1-based place in the stated priorities, or null when none are stated (or it isn't listed). */
  rank: number | null;
  decided: number;
  checked: number;
  minutes_est: number;
  /** Seconds its cards were in front of the person, from the record's attention events. */
  seconds_measured: number;
}

export interface ReviewDispatch {
  brief: string;
  headline: string;
  estimate_minutes: number;
  /** Reported minutes from copy (or launch) to report; null with no report yet, or with a report and no start time. */
  minutes: number | null;
  /** Reported cost, or null: shown as "not reported". */
  cost_usd: number | null;
  /** The report's outcome; null means no report yet. */
  outcome: string | null;
  synthetic: boolean;
}

export interface Review {
  projects: ReviewProject[];
  /** The project with the most estimated time, if any time was spent. */
  top: ReviewProject | null;
  /** Asked this morning, from each answer event's own route. */
  asked: { decide: number; check_in: number };
  feedback: Record<FeedbackChoice, number>;
  dispatch: ReviewDispatch[];
  /** Measured time on cards this morning, every prompt counted, and how many decisions it covers. */
  measured: { seconds: number; decisions: number };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * The review's numbers, from the record alone: answers by project (each counted once, on the route its
 * answer event recorded), feedback taps, and Dispatch copies and reports. Projects come in the stated
 * priority order, then any others in their given order.
 */
export function reviewOf(input: {
  record: RecordLike[];
  projectOf: (id: string) => string | undefined;
  projects: { id: string; name: string }[];
  priorities: readonly string[] | null;
}): Review {
  const { record, projectOf, projects, priorities } = input;
  // The latest answer per decision: a decision is answered once, but a re-answer must not count twice.
  const answers = new Map<string, RecordLike>();
  for (const r of record) if (r.kind === "answer" && r.id) answers.set(r.id, r);
  const rows = new Map<string, ReviewProject>();
  const order = [...(priorities ?? []).filter((id) => projects.some((p) => p.id === id)), ...projects.map((p) => p.id).filter((id) => !priorities?.includes(id))];
  for (const id of order) {
    const rank = priorities ? priorities.indexOf(id) : -1;
    rows.set(id, { id, name: projects.find((p) => p.id === id)!.name, rank: rank >= 0 ? rank + 1 : null, decided: 0, checked: 0, minutes_est: 0, seconds_measured: 0 });
  }
  const asked = { decide: 0, check_in: 0 };
  for (const [id, r] of answers) {
    const decide = r.route === "decide";
    if (decide) asked.decide++;
    else asked.check_in++;
    const row = rows.get(projectOf(id) ?? "");
    if (!row) continue;
    if (decide) row.decided++;
    else row.checked++;
    row.minutes_est += answerMinutes(r.route);
  }
  // Measured attention (docs/STAGE-11.md): every stretch a card was in front of the person.
  const measured = { seconds: 0, decisions: 0 };
  const timed = new Set<string>();
  for (const r of record) {
    const s = r.kind === "attention" && r.id ? num(r.seconds) : null;
    if (s === null || s <= 0) continue;
    measured.seconds += s;
    timed.add(r.id!);
    const row = rows.get(projectOf(r.id!) ?? "");
    if (row) row.seconds_measured += s;
  }
  measured.decisions = timed.size;
  const list = [...rows.values()];
  const top = list.reduce<ReviewProject | null>((best, p) => (p.minutes_est > (best?.minutes_est ?? 0) ? p : best), null);

  const feedback: Record<FeedbackChoice, number> = { all: 0, some: 0, none: 0 };
  const byTransition = new Map<string, FeedbackChoice>();
  for (const r of record) if (r.kind === "feedback" && typeof r.transition === "string" && (r.choice === "all" || r.choice === "some" || r.choice === "none")) byTransition.set(r.transition, r.choice);
  for (const c of byTransition.values()) feedback[c]++;

  const briefs = new Map<string, ReviewDispatch>();
  for (const r of record) {
    if ((r.kind !== "dispatch" && r.kind !== "dispatch_report") || typeof r.brief !== "string") continue;
    // A copy the clipboard refused stays in the record as an attempt, but nothing went out.
    if (r.kind === "dispatch" && r.copied === false) continue;
    const prev = briefs.get(r.brief);
    const row: ReviewDispatch = prev ?? { brief: r.brief, headline: "", estimate_minutes: 0, minutes: null, cost_usd: null, outcome: null, synthetic: false };
    if (typeof r.headline === "string" && r.headline) row.headline = r.headline;
    row.estimate_minutes = num(r.estimate_minutes) ?? row.estimate_minutes;
    if (r.kind === "dispatch_report") {
      row.minutes = num(r.minutes);
      row.cost_usd = num(r.cost_usd);
      row.outcome = typeof r.outcome === "string" ? r.outcome : null;
      row.synthetic = r.synthetic === true;
    }
    briefs.set(r.brief, row);
  }
  return { projects: list, top, asked, feedback, dispatch: [...briefs.values()], measured };
}

/** A runner launch counts as sent once it is running; one still starting may yet fail. */
export const launchCounts = (l: { state: string } | undefined): boolean => l?.state === "running";
