// The page's state: the queue from the Worker (Q), the person's morning (S, kept in localStorage),
// the decisions by id, and the answer in progress on the card in front of the person (F). Other
// modules read these as live bindings but cannot assign to them, so every replacement goes through a
// setter below. Nothing here touches the DOM.

import { GLOW_START, type Guess, type Mood } from "../shared/lifecycle";
import type { Card, Decision, Fact, FactOutput, Persona, RouteKind, Rule, Source } from "../shared/types";

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
}

export const STORE_KEY = "bugme.state.v1";
export let Q: Queue;
export let S: State;
export let byId = new Map<string, Decision>();

/** The in-progress answer on the card in front of the person (not persisted mid-flow). */
export interface Flow {
  id: string;
  choice: string | null;
  basis: string;
  phase: "choose" | "busy" | "pushback" | "why" | "proposal" | "done";
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
  return { id, choice: null, basis: "", phase: "choose", pushback: null, initial: null, guess: null, send_down: "", proposal: null, message: "", rerouted: [], factDraft: "", error: "", card: null };
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
        for (const [id, f] of Object.entries(s.flows ?? {})) {
          if (f.phase !== "busy") flows[id] = f;
          else if (s.answered[id]) flows[id] = { ...f, phase: "done", message: "The page reloaded before this finished; your answer and reason are recorded." };
        }
        return { ...base, ...s, flows, evaluated: s.evaluated ?? {}, changes, cards: { ...base.cards, ...kept }, pending: [], pendingCause: {} };
      }
    }
  } catch {
    /* corrupted or unavailable storage: start fresh */
  }
  return fresh(q);
}

export function log(kind: string, data: Record<string, unknown> = {}): void {
  S.record.push({ at: new Date().toISOString(), kind, ...data });
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
