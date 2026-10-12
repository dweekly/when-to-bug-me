// The decision as a conversation (docs/STAGE-6.md): the shapes of a thread, checking the model's
// reading of it, and the one function that decides what Bug Me does next. Shared by the Worker (checks
// a reply before it is returned or cached), the page (renders and closes the thread) and the recorder.
//
// The model proposes; code disposes. `advance` owns both the next state and the visible reply: when it
// overrides the model, it writes the read-back itself from the verified ledger, so the person never
// sees a question code has just ruled out.

import { MAX_CONVERSE_QUESTIONS, MAX_CONVERSE_TURNS, MAX_EVIDENCE_CHARS, MAX_REASON_CHARS, MAX_REPLY_CHARS, MAX_TRANSCRIPT_CHARS } from "./constants";

/** Longest routed-card reason a request may carry, and longest Bug Me turn (a read-back can quote conditions). */
const MAX_WHY_HERE_CHARS = 600;
const MAX_BUG_TURN_CHARS = 3000;
import { findQuote } from "./parse";
import type { Decision } from "./types";

/** One of Jordan's turns as sent: the words (may be empty when there is a pick) and the option clicked since the last turn. */
export interface JordanTurn {
  who: "jordan";
  text: string;
  pick?: string;
}

/** One of Bug Me's turns, as shown. `next` is what the turn did: asked, read the outcome back, or closed. */
export interface BugTurn {
  who: "bugme";
  text: string;
  next: Next;
}

export type ConvTurn = JordanTurn | BugTurn;
export type Next = "ask" | "confirm" | "close";

/** Words copied from one of Jordan's turns; `turn` counts Jordan's turns only, from 0. */
export interface Quote {
  turn: number;
  quote: string;
}

/** The current interpretation of everything Jordan has said. Replaced, not merged, on every turn. */
export interface Ledger {
  /** An option key, "other", "reject" (the question or its framing is rejected), or "none". */
  choice: string;
  /** The words that made the choice, when it came from words rather than a click. */
  choice_quote: Quote | null;
  /** Jordan's words for "other" or "reject". */
  course: Quote | null;
  /** For "other" or "reject": an imperative of at most five words, for the button. */
  action: string;
  why: Quote[];
  conditions: Quote[];
  /** Jordan's questions; `answer` is null when the agent's material doesn't say. */
  questions: { quote: Quote; answer: string | null }[];
  /** What Jordan said about the question itself. */
  feedback: { quote: Quote; kind: "priority" | "routing" }[];
  /** Jordan asked Bug Me to stop asking ("just do it"). */
  no_more_questions: boolean;
}

/** What /api/converse returns. */
export interface ConverseResult {
  reply: string;
  next: Next;
  ledger: Ledger;
  /** Set when code changed the model's `next` (and so wrote the reply). */
  forced?: string;
}

export class ConverseError extends Error {}

export const EMPTY_LEDGER: Ledger = {
  choice: "none",
  choice_quote: null,
  course: null,
  action: "",
  why: [],
  conditions: [],
  questions: [],
  feedback: [],
  no_more_questions: false,
};

export const jordanTurns = (turns: ConvTurn[]): JordanTurn[] => turns.filter((t): t is JordanTurn => t.who === "jordan");
export const bugTurns = (turns: ConvTurn[]): BugTurn[] => turns.filter((t): t is BugTurn => t.who === "bugme");

/** Elicitation questions Bug Me has actually asked in this thread. */
export function questionsAsked(turns: ConvTurn[]): number {
  return bugTurns(turns).filter((t) => t.next === "ask").length;
}

/** The most recent option Jordan clicked, if any. */
export function lastPick(turns: ConvTurn[]): string | undefined {
  const js = jordanTurns(turns);
  for (let i = js.length - 1; i >= 0; i--) if (js[i].pick) return js[i].pick;
  return undefined;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** A quote that really is in the named turn of Jordan's, or null. */
function quoteIn(js: JordanTurn[], raw: unknown): Quote | null {
  if (!raw || typeof raw !== "object") return null;
  const { turn, quote } = raw as Record<string, unknown>;
  if (typeof turn !== "number" || !Number.isInteger(turn) || typeof quote !== "string") return null;
  const t = js[turn];
  return t && findQuote(t.text, quote) ? { turn, quote } : null;
}

/** How many quotes in a raw model ledger fail verification (the eval checks this before sanitizing). */
export function unverifiedQuotes(raw: unknown, turns: ConvTurn[]): number {
  const js = jordanTurns(turns);
  const o = (raw && typeof raw === "object" ? (raw as Record<string, unknown>).ledger ?? raw : {}) as Record<string, unknown>;
  let bad = 0;
  const check = (q: unknown) => {
    if (q && typeof q === "object" && str((q as Record<string, unknown>).quote) && !quoteIn(js, q)) bad++;
  };
  check(o.choice_quote);
  check(o.course);
  for (const k of ["why", "conditions"] as const) for (const q of Array.isArray(o[k]) ? o[k] : []) check(q);
  for (const k of ["questions", "feedback"] as const) for (const q of Array.isArray(o[k]) ? o[k] : []) check(q);
  return bad;
}

/**
 * Check the model's ledger against the thread: the choice is one of this decision's keys, "other",
 * "reject" or "none"; every quote is literally in the turn it names (others are dropped, not fatal);
 * "other" and "reject" need a verified, non-empty course, or the choice falls back to "none".
 * Quotes arrive flat from the schema ({turn, quote} with quote "" for none); questions carry
 * `answerable` and `answer`.
 */
export function sanitizeLedger(raw: unknown, d: Decision, turns: ConvTurn[]): Ledger {
  if (!raw || typeof raw !== "object") throw new ConverseError("ledger is not an object");
  const o = raw as Record<string, unknown>;
  const js = jordanTurns(turns);
  const keys = d.options.map((x) => x.key);
  const choiceRaw = str(o.choice);
  if (![...keys, "other", "reject", "none"].includes(choiceRaw)) throw new ConverseError("choice is not an option key, other, reject or none");
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  const course = quoteIn(js, o.course);
  let choice = choiceRaw;
  if ((choice === "other" || choice === "reject") && !course?.quote.trim()) choice = "none";
  const questions = list(o.questions).flatMap((q) => {
    const quote = quoteIn(js, q);
    if (!quote) return [];
    const r = q as Record<string, unknown>;
    const answer = r.answerable === true && str(r.answer).trim() ? str(r.answer).trim().slice(0, MAX_REPLY_CHARS) : null;
    return [{ quote, answer }];
  });
  const feedback = list(o.feedback).flatMap((f) => {
    const quote = quoteIn(js, f);
    const kind = str((f as Record<string, unknown>)?.kind);
    return quote && (kind === "priority" || kind === "routing") ? [{ quote, kind: kind as "priority" | "routing" }] : [];
  });
  return {
    choice,
    choice_quote: keys.includes(choice) || choice === "other" || choice === "reject" ? quoteIn(js, o.choice_quote) : null,
    course: choice === "other" || choice === "reject" ? course : null,
    action: choice === "other" || choice === "reject" ? str(o.action).trim().split(/\s+/).slice(0, 5).join(" ") : "",
    why: list(o.why).flatMap((q) => quoteIn(js, q) ?? []),
    conditions: list(o.conditions).flatMap((q) => quoteIn(js, q) ?? []),
    questions,
    feedback,
    no_more_questions: o.no_more_questions === true,
  };
}

/** What a thread resolves to, if Jordan confirmed it now. */
export type Outcome =
  | { kind: "option"; key: string }
  | { kind: "other" }
  | { kind: "rejected" }
  | { kind: "ask-agent"; questions: string[] }
  | { kind: "set-aside" };

export function outcomeOf(d: Decision, l: Ledger): Outcome {
  if (d.options.some((o) => o.key === l.choice)) return { kind: "option", key: l.choice };
  if (l.choice === "other" && l.course) return { kind: "other" };
  if (l.choice === "reject" && l.course) return { kind: "rejected" };
  const open = l.questions.filter((q) => q.answer === null).map((q) => q.quote.quote);
  return open.length ? { kind: "ask-agent", questions: open } : { kind: "set-aside" };
}

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const sentence = (s: string) => s.trim().replace(/[.!?\s]+$/, "");

/** The primary button once the thread has been read back: the decision itself. */
export function primaryLabel(d: Decision, l: Ledger): string {
  const o = outcomeOf(d, l);
  if (o.kind === "option") return d.options.find((x) => x.key === o.key)!.label;
  if (o.kind === "other" || o.kind === "rejected") return l.action || (o.kind === "other" ? "Do something else" : "Reject the question");
  if (o.kind === "ask-agent") return "Ask the agent";
  return "Skip";
}

/** The read-back code writes when it overrides the model: one fixed template per outcome. */
export function readBack(d: Decision, l: Ledger): string {
  const o = outcomeOf(d, l);
  if (o.kind === "option") {
    const label = lowerFirst(d.options.find((x) => x.key === o.key)!.label);
    const conds = l.conditions.map((c) => sentence(c.quote)).join("; ");
    return `So: ${label}${conds ? `, ${conds}` : ""}. Right?`;
  }
  if (o.kind === "other") return `So: not either option. ${sentence(l.course!.quote)}. Right?`;
  if (o.kind === "rejected") return `So you're rejecting the question: ${sentence(l.course!.quote)}. I'll tell the agent. Right?`;
  if (o.kind === "ask-agent") return `I'll ask the agent: ${o.questions.map(sentence).join("; ")}, and set this aside.`;
  return "Want to set this aside for now?";
}

/**
 * Decide what Bug Me does next, given the thread so far (ending with Jordan's newest turn), the
 * model's reply, its `next`, and the verified ledger. Rules, in order:
 * - a "close" counts only straight after a read-back (the last Bug Me turn was "confirm"), and only
 *   when the outcome is something that can be sent; otherwise it becomes a read-back;
 * - an "ask" is allowed while fewer than MAX_CONVERSE_QUESTIONS have been asked and Jordan hasn't
 *   said to stop; otherwise it becomes a read-back;
 * - a model read-back is kept as written.
 * The reply is trimmed to MAX_REPLY_CHARS.
 */
export function advance(d: Decision, turns: ConvTurn[], reply: string, next: Next, ledger: Ledger): ConverseResult {
  const last = bugTurns(turns).at(-1);
  const sendable = outcomeOf(d, ledger).kind !== "set-aside";
  const clip = (s: string) => (s.length > MAX_REPLY_CHARS ? `${s.slice(0, MAX_REPLY_CHARS - 1).trimEnd()}…` : s);
  if (next === "close") {
    if (last?.next === "confirm" && sendable) return { reply: clip(reply.trim()), next: "close", ledger };
    return { reply: readBack(d, ledger), next: "confirm", ledger, forced: last?.next === "confirm" ? "nothing to send yet" : "close before a read-back" };
  }
  if (next === "ask") {
    if (ledger.no_more_questions) return { reply: readBack(d, ledger), next: "confirm", ledger, forced: "asked to stop asking" };
    if (questionsAsked(turns) >= MAX_CONVERSE_QUESTIONS) return { reply: readBack(d, ledger), next: "confirm", ledger, forced: "question cap" };
    return { reply: clip(reply.trim()), next: "ask", ledger };
  }
  return { reply: clip(reply.trim()) || readBack(d, ledger), next: "confirm", ledger };
}

/** Everything the close path is given from a confirmed thread, all in Jordan's words. */
export interface CloseInputs {
  outcome: Outcome;
  /** The why quotes joined; "" when none, so the backstop can still ask (unless suppressed below). */
  reason: string;
  /** The condition quotes joined. */
  conditions: string;
  /** For "other" and "rejected": Jordan's words for the course. */
  course: string;
  /** All of Jordan's turns, in order. */
  narration: string;
  /** The why, condition and feedback quotes, whole and in order, within MAX_EVIDENCE_CHARS. */
  evidence: string;
  /** Feedback about the question itself: a reason to propose guidance even on an expected answer. */
  hasFeedback: boolean;
  /** The conversation already asked an elicitation question: "I'm curious: why?" stays quiet. */
  whyAsked: boolean;
  noMoreQuestions: boolean;
}

export function closeInputs(d: Decision, turns: ConvTurn[], l: Ledger): CloseInputs {
  // Quotes are joined verbatim; one that doesn't end a sentence is followed by "; " so two clauses don't run together.
  // Quotes are joined verbatim; one that doesn't end a sentence is followed by "; " so two clauses don't run together.
  const glue = (a: string, q: string) => (!a ? q : `${a}${/[.!?;:,]$/.test(a) ? " " : "; "}${q}`);
  const join = (qs: Quote[]) => qs.map((q) => q.quote.trim()).reduce(glue, "");
  // Whole quotes, in order, while they fit.
  let evidence = "";
  for (const q of [...l.why, ...l.conditions, ...l.feedback.map((f) => f.quote)]) {
    const t = q.quote.trim();
    if (!t) continue;
    const next = glue(evidence, t);
    if (next.length > MAX_EVIDENCE_CHARS) break;
    evidence = next;
  }
  return {
    outcome: outcomeOf(d, l),
    reason: join(l.why),
    conditions: join(l.conditions),
    course: l.course?.quote.trim() ?? "",
    narration: jordanTurns(turns).map((t) => t.text.trim()).filter(Boolean).join("\n"),
    evidence,
    hasFeedback: l.feedback.length > 0,
    whyAsked: questionsAsked(turns) > 0,
    noMoreQuestions: l.no_more_questions,
  };
}

/** The thread as the model sees it, and as the recording key covers it: words, picks and Bug Me's
 *  replies, nothing about timing, seals or source labels. */
export function transcriptForPrompt(d: Decision, turns: ConvTurn[], first: string): string {
  let j = 0;
  return turns
    .map((t) => {
      if (t.who === "bugme") return `Bug Me: ${t.text}`;
      const pick = t.pick ? d.options.find((o) => o.key === t.pick) : undefined;
      const head = `${first} [turn ${j++}]`;
      return `${head}: ${pick ? `(clicked option ${pick.key}, "${pick.label}") ` : ""}${t.text || "(no words)"}`;
    })
    .join("\n");
}

/**
 * Check a /api/converse request body and project it to exactly what the model sees: the routed card's
 * route and reason (never `sealed` or `source`), and the turns' words, picks and Bug Me's `next`.
 * Jordan's words are kept exactly as sent, since quotes are checked against them.
 */
export function parseConverseRequest(b: Record<string, unknown>, d: Decision): { card: { route: "settle" | "check_in" | "decide"; why_here: string }; turns: ConvTurn[] } {
  const c = (b.card && typeof b.card === "object" ? b.card : {}) as Record<string, unknown>;
  const route = c.route;
  if (route !== "settle" && route !== "check_in" && route !== "decide") throw new ConverseError("card.route must be settle, check_in or decide");
  const why_here = str(c.why_here).trim();
  if (why_here.length > MAX_WHY_HERE_CHARS) throw new ConverseError(`card.why_here is longer than ${MAX_WHY_HERE_CHARS} characters`);
  if (!Array.isArray(b.turns) || !b.turns.length) throw new ConverseError("turns must be a non-empty list");
  const keys = d.options.map((o) => o.key);
  const turns: ConvTurn[] = b.turns.map((t, i): ConvTurn => {
    const o = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
    if (typeof o.text !== "string") throw new ConverseError(`turns[${i}].text must be a string`);
    if (o.who === "bugme") {
      if (o.next !== "ask" && o.next !== "confirm" && o.next !== "close") throw new ConverseError(`turns[${i}].next must be ask, confirm or close`);
      if (o.text.length > MAX_BUG_TURN_CHARS) throw new ConverseError(`turns[${i}] is too long`);
      return { who: "bugme", text: o.text, next: o.next };
    }
    if (o.who !== "jordan") throw new ConverseError(`turns[${i}].who must be jordan or bugme`);
    if (o.text.length > MAX_REASON_CHARS) throw new ConverseError(`turns[${i}] is longer than ${MAX_REASON_CHARS} characters`);
    if (o.pick !== undefined && (typeof o.pick !== "string" || !keys.includes(o.pick))) throw new ConverseError(`turns[${i}].pick is not an option of this decision`);
    if (!o.text.trim() && !o.pick) throw new ConverseError(`turns[${i}] has neither words nor a pick`);
    return o.pick ? { who: "jordan", text: o.text, pick: o.pick as string } : { who: "jordan", text: o.text };
  });
  if (turns.at(-1)!.who !== "jordan") throw new ConverseError("the last turn must be Jordan's");
  const js = jordanTurns(turns);
  if (js.length > MAX_CONVERSE_TURNS) throw new ConverseError(`a thread holds at most ${MAX_CONVERSE_TURNS} of Jordan's turns`);
  if (js.reduce((n, t) => n + t.text.length, 0) > MAX_TRANSCRIPT_CHARS) throw new ConverseError(`a thread holds at most ${MAX_TRANSCRIPT_CHARS} characters of Jordan's words`);
  return { card: { route, why_here }, turns };
}
