// The page's state: the queue from the Worker (Q), the person's morning (S, kept in localStorage),
// the decisions by id, and the answer in progress on the card in front of the person (F). Other
// modules read these as live bindings but cannot assign to them, so every replacement goes through a
// setter below. Nothing here touches the DOM.

import { GLOW_START, type Guess, type Mood } from "../shared/lifecycle";
import type { Punt, PuntKind } from "../shared/punt";
import type { BugTurn, JordanTurn, Ledger } from "../shared/converse";
import type { Card, Decision, Fact, FactOutput, Mark, Persona, RouteKind, Rule, Source } from "../shared/types";
import type { Catalog } from "../shared/dispatch";
import type { Transition } from "../shared/reflection";
import { OWNER_PAGE } from "./livemode";

export type Unavailable = { id: string; unavailable: string };
export type AnyCard = Card | Unavailable;
export const isCard = (c: AnyCard | undefined): c is Card => Boolean(c) && !("unavailable" in (c as object));

export interface Queue {
  persona: Persona;
  rules: Rule[];
  facts: Fact[];
  decisions: Decision[];
  cards: AnyCard[];
  live_available: boolean;
  mode: "fake" | "live" | "recorded";
  turnstile_site_key: string | null;
  /** The owner's live queue (docs/STAGE-7.md), not the simulation. */
  owner?: boolean;
  /** On /me: what is set aside, from the server. */
  aside?: { id: string; kind: string; reason: string; instruction: string; at: string }[];
  /** On /me: answered in the last day, for this browser's own follow-ups. */
  answered?: { decision: Decision; card: Card }[];
  /** The public site's Dispatch catalog: Jordan's synthetic tools (docs/STAGE-8.md). */
  catalog?: Catalog;
}

export interface Answer {
  initial: string;
  final: string;
  basis: string;
  guess: Guess;
  route: RouteKind;
  pushback: string | null;
  send_down: string;
  marks: string[];
  /** The person's "but…" phrases, verbatim, sent down with the option they chose. */
  conditions?: string;
  /** "Something else": the course the person described instead (final is then "other"), verbatim. */
  other?: string;
  /** Everything the person said or typed thinking it through, and what Bug Me picked out of it. */
  narration?: string;
  narrationMarks?: Mark[];
  /** How the conversation ended: a listed option, a course of the person's own, or the question rejected. */
  outcome?: "option" | "other" | "rejected";
  /** The conversation that led here, as it was shown, and what Bug Me heard (docs/STAGE-6.md). */
  thread?: Thread;
}

/** A Bug Me turn as the page keeps it: what the Worker returned, plus where the words came from. */
export type ShownBugTurn = BugTurn & { source?: Source };
export type ShownTurn = JordanTurn | ShownBugTurn;
export interface Thread {
  turns: ShownTurn[];
  ledger: Ledger;
}

/** One entry in the record: every guess made before an answer, the answer, the basis and the marks. */
export interface RecordEvent {
  at: string;
  kind: string;
  id?: string;
  [k: string]: unknown;
}

export interface State {
  rules: Rule[];
  facts: Fact[];
  cards: Record<string, AnyCard>;
  answered: Record<string, Answer>;
  /** Settled decisions the person undid; they come back as check-ins and are never re-settled. */
  reopened: string[];
  settledMarks: Record<string, string[]>;
  record: RecordEvent[];
  glow: number;
  mood: Mood;
  pushbacksUsed: number;
  current: string | null;
  /** id -> a one-line note on why its route just changed. */
  changes: Record<string, string>;
  pending: string[];
  /** The cause that first queued each pending re-check, kept if a newer edit takes over the pass. */
  pendingCause: Record<string, string>;
  /** Cards re-evaluated under the person's own rules and facts; kept across reloads. */
  evaluated: Record<string, true>;
  /**
   * The answer in progress on each decision, kept by decision so a follow-up (pushback, "why?",
   * proposed guidance) is never lost by opening another card or reloading.
   */
  flows: Record<string, Flow>;
  newFacts: string[];
  /** Bumped on every rule or fact change; answers from an older version are ignored. */
  version: number;
  /** Decisions set aside with "Skip", by id. Removed on Resume; the record keeps the history. */
  punts: Record<string, Punt>;
  /** The project the person is working through in focus, so Next finishes it before moving on. */
  sessionProject: string | null;
  /** Every time a decision was set aside and later resumed, oldest first; shown when it comes back. */
  puntHistory: Record<string, Punt[]>;
  /** Changes of project, counted at Next (docs/STAGE-10.md, 10c): what each offered and what was tapped. */
  transitions: Transition[];
}

/** Bumped whenever a saved morning can no longer be read faithfully, and the old one starts fresh:
 *  v2 when thinking out loud replaced stage 3's drafts; v3 when stage 5 rebuilt the morning (a saved
 *  answer or set-aside could name a question that no longer exists). */
// The owner's live queue keeps its own drafts, apart from the simulation's (docs/STAGE-7.md).
export const STORE_KEY = OWNER_PAGE ? "bugme.live.v1" : "bugme.state.v4";
const OLD_STORE_KEYS = ["bugme.state.v1", "bugme.state.v2", "bugme.state.v3"];
export let Q: Queue;
export let S: State;
export let byId = new Map<string, Decision>();

/** The in-progress answer on the card in front of the person. */
export interface Flow {
  id: string;
  /** The option lit on the card: a click not yet sent, else what Bug Me heard. Set to the answer once sent. */
  choice: string | null;
  /** An option clicked since Jordan's last turn; it travels with the next turn. */
  pick: string | null;
  /** The reason given to the answer path; in the "why?" phase, the text of that box. */
  basis: string;
  phase: "choose" | "busy" | "pushback" | "why" | "proposal" | "done" | "punting";
  /** The conversation so far, and what Bug Me last said it heard. */
  turns: ShownTurn[];
  ledger: Ledger | null;
  /** The words in the composer, not yet sent, and their revision (bumped on every edit). */
  think: string;
  rev: number;
  /** Turns of Jordan's submitted so far, replacements included: the voice target follows it. */
  sent: number;
  /** From the confirmed thread, for the close path: the guidance evidence (why, conditions and
   *  feedback quotes), and what the "why?" backstop and the guidance offer need to know. */
  evidence: string;
  noMoreQuestions: boolean;
  hasFeedback: boolean;
  /** The person's "but…" phrases as sent with the answer. */
  conditions: string;
  /** All of the person's turns, as submitted with the answer. */
  narration: { narration: string; narrationMarks: Mark[]; unparsed: boolean } | null;
  /** While setting the decision aside: the kind chosen and the sentence so far. */
  puntKind: PuntKind | null;
  puntReason: string;
  /** The phase to return to if the person cancels setting it aside. */
  puntFrom: "choose" | "pushback" | null;
  pushback: string | null;
  initial: string | null;
  guess: Guess | null;
  send_down: string;
  proposal: (FactOutput & { reroute: string[]; source: Source }) | null;
  message: string;
  /** Decisions whose route changed because of guidance kept on this card. */
  rerouted: string[];
  /** The proposed guidance as the person is editing it, kept across re-renders. */
  factDraft: string;
  /** Why the last attempt to keep guidance was refused (too long, too many). */
  error: string;
  /** The card as it was when the person answered: its sealed guess is the one both answer steps use. */
  card: Card | null;
}

export function newFlow(id: string): Flow {
  return { id, choice: null, pick: null, basis: "", phase: "choose", turns: [], ledger: null, think: "", rev: 0, sent: 0, evidence: "", noMoreQuestions: false, hasFeedback: false, conditions: "", narration: null, pushback: null, initial: null, guess: null, send_down: "", proposal: null, message: "", rerouted: [], factDraft: "", error: "", card: null, puntKind: null, puntReason: "", puntFrom: null };
}

/** A conversation has started on this decision and isn't finished: it stays with the person. */
export function talking(id: string): boolean {
  const f = S.flows[id];
  return Boolean(f && f.turns.length && !S.answered[id]);
}

/** A follow-up still waiting on the person after they answered (or while a request is out). */
export function unfinished(id: string): boolean {
  const f = S.flows[id];
  return Boolean(f) && ["busy", "pushback", "why", "proposal"].includes(f.phase);
}

export let F: Flow | null = null;

export function fresh(q: Queue): State {
  return {
    rules: structuredClone(q.rules),
    facts: structuredClone(q.facts),
    cards: Object.fromEntries(q.cards.map((c) => [c.id, c])),
    answered: {},
    reopened: [],
    settledMarks: {},
    record: [],
    glow: GLOW_START,
    mood: "neutral",
    pushbacksUsed: 0,
    current: null,
    changes: {},
    pending: [],
    pendingCause: {},
    evaluated: {},
    flows: {},
    newFacts: [],
    version: 0,
    punts: {},
    sessionProject: null,
    puntHistory: {},
    transitions: [],
  };
}

export function save(): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(S));
  } catch {
    /* storage may be unavailable (private window, blocked); the page still works without it */
  }
}

export function load(q: Queue): State {
  try {
    for (const k of OLD_STORE_KEYS) localStorage.removeItem(k);
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as State;
      if (s && s.cards && s.rules && s.facts && s.answered) {
        // Cards the person's own changes produced are kept; every other card comes fresh from this
        // load, so a redeploy (new seal key, new recorded run) never leaves stale sealed guesses behind.
        const base = fresh(q);
        const kept = Object.fromEntries(Object.entries(s.cards).filter(([id]) => s.evaluated?.[id] || s.changes?.[id]));
        // A re-check interrupted by the reload is not silently dropped: it is marked possibly stale.
        const changes = { ...(s.changes ?? {}) };
        for (const id of s.pending ?? []) changes[id] = "A re-check was interrupted when the page reloaded, so this may be out of date.";
        // A request in flight when the page reloaded is gone: an answered card's follow-up ends
        // there (its answer and reason are already recorded); an unanswered one starts over.
        const flows: Record<string, Flow> = {};
        for (const [id, saved] of Object.entries(s.flows ?? {})) {
          const f = { ...newFlow(id), ...saved }; // fields added since this morning was saved get defaults
          // A turn that was out when the page reloaded keeps its words; the card offers "Send again".
          if (f.phase === "punting") flows[id] = { ...f, phase: f.puntFrom ?? "choose" };
          else if (f.phase !== "busy") flows[id] = f;
          else if (!s.answered[id]) flows[id] = { ...f, phase: "choose", message: "The page reloaded before that was sent; send it again." };
          else if (s.answered[id]) flows[id] = { ...f, phase: "done", message: "The page reloaded before this finished; your answer and reason are recorded." };
        }
        return { ...base, ...s, transitions: Array.isArray(s.transitions) ? s.transitions : [], punts: s.punts ?? {}, puntHistory: s.puntHistory ?? {}, sessionProject: s.sessionProject ?? null, flows, evaluated: s.evaluated ?? {}, changes, cards: { ...base.cards, ...kept }, pending: [], pendingCause: {} };
      }
    }
  } catch {
    /* corrupted or unavailable storage: start fresh */
  }
  return fresh(q);
}

export function log(kind: string, data: Record<string, unknown> = {}): void {
  // The event's own time and kind come last, so no field in `data` can overwrite them.
  S.record.push({ ...data, at: new Date().toISOString(), kind });
}

export function setQ(q: Queue): void {
  Q = q;
}

export function setS(s: State): void {
  S = s;
}

export function setById(m: Map<string, Decision>): void {
  byId = m;
}

export function setF(f: Flow | null): void {
  F = f;
}
