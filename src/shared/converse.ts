// The decision as a conversation (docs/STAGE-6.md): the shapes of a thread, checking the model's
// reading of it, and the one function that decides what Bug Me does next. Shared by the Worker (checks
// a reply before it is returned or cached), the page (renders and closes the thread) and the recorder.
//
// The model proposes; code disposes. `advance` owns both the next state and the visible reply: when it
// overrides the model, it writes the read-back itself from the verified ledger, so the person never
// sees a question code has just ruled out.

import { MAX_CONVERSE_QUESTIONS, MAX_CONVERSE_TURNS, MAX_EVIDENCE_CHARS, MAX_EXPLAIN_CHARS, MAX_HUH, MAX_REASON_CHARS, MAX_REPLY_CHARS, MAX_TRANSCRIPT_CHARS } from "./constants";

/** Longest routed-card reason a request may carry, and longest Bug Me turn (a read-back can quote conditions). */
const MAX_WHY_HERE_CHARS = 600;
const MAX_BUG_TURN_CHARS = 3000;
import { findQuote } from "./parse";
import type { Decision } from "./types";

/** One of Jordan's turns as sent: the words (may be empty when there is a pick) and the option clicked
 *  since the last turn. `huh` is a press of "Huh?" (docs/STAGE-6E.md): no words, no pick, and a request
 *  to re-present the last thing Bug Me showed in plainer terms. */
export interface JordanTurn {
  who: "jordan";
  text: string;
  pick?: string;
  huh?: true;
}

/** One of Bug Me's turns, as shown. `next` is what the turn did: asked, read the outcome back, closed,
 *  or re-presented the question in plainer terms ("explain"). */
export interface BugTurn {
  who: "bugme";
  text: string;
  next: Next;
  /** On a read-back: a fingerprint of the decision it read back (`ConverseResult.heard`), so a later
   *  "yes" can be checked against what Jordan actually saw. Not shown to the model. */
  heard?: string;
}

export type ConvTurn = JordanTurn | BugTurn;
export type Next = "ask" | "confirm" | "close" | "explain";

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
  /** What Jordan said about the question itself: more or less urgent than framed ("priority"), it
   *  should or shouldn't have come to Jordan ("routing"), or Bug Me's translation didn't make sense
   *  ("unclear", which is about Bug Me, not the decision). */
  feedback: { quote: Quote; kind: FeedbackKind }[];
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
  /** On a read-back: the fingerprint of what was read back (`heard`). The page stores it on the Bug Me
   *  turn and sends it back with the thread. */
  heard?: string;
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

export type FeedbackKind = "priority" | "routing" | "unclear";
const FEEDBACK_KINDS: readonly string[] = ["priority", "routing", "unclear"];

export const jordanTurns = (turns: ConvTurn[]): JordanTurn[] => turns.filter((t): t is JordanTurn => t.who === "jordan");
/** Presses of "Huh?" in the thread. */
export const huhs = (turns: ConvTurn[]): number => jordanTurns(turns).filter((t) => t.huh).length;
/** Jordan's turns that count toward MAX_CONVERSE_TURNS: everything but a "Huh?". */
export const wordTurns = (turns: ConvTurn[]): number => jordanTurns(turns).filter((t) => !t.huh).length;
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
    return quote && FEEDBACK_KINDS.includes(kind) ? [{ quote, kind: kind as FeedbackKind }] : [];
  });
  // "What does that mean?" is about Bug Me's wording, not a question for the agent or a reason: a clause
  // marked unclear is dropped from the questions, reasons and conditions (docs/STAGE-6E.md).
  const unclear = feedback.filter((f) => f.kind === "unclear").map((f) => f.quote);
  const overlaps = (x: Quote) => unclear.some((u) => u.turn === x.turn && (u.quote.includes(x.quote) || x.quote.includes(u.quote)));
  const notUnclear = (x: Quote) => !overlaps(x);
  return {
    choice,
    choice_quote: keys.includes(choice) || choice === "other" || choice === "reject" ? quoteIn(js, o.choice_quote) : null,
    course: choice === "other" || choice === "reject" ? course : null,
    action: choice === "other" || choice === "reject" ? str(o.action).trim().split(/\s+/).slice(0, 5).join(" ") : "",
    why: list(o.why).flatMap((q) => quoteIn(js, q) ?? []).filter(notUnclear),
    conditions: list(o.conditions).flatMap((q) => quoteIn(js, q) ?? []).filter(notUnclear),
    questions: questions.filter((q) => notUnclear(q.quote)),
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

/** Jordan's questions the agent's material didn't answer, in Jordan's words. With a decision they go
 *  down with it; with none, they are the outcome ("ask-agent"). */
export function openQuestions(l: Ledger): string[] {
  return l.questions.filter((q) => q.answer === null).map((q) => q.quote.quote.trim()).filter(Boolean);
}

export function outcomeOf(d: Decision, l: Ledger): Outcome {
  if (d.options.some((o) => o.key === l.choice)) return { kind: "option", key: l.choice };
  if (l.choice === "other" && l.course) return { kind: "other" };
  if (l.choice === "reject" && l.course) return { kind: "rejected" };
  const open = openQuestions(l);
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
  const conds = l.conditions.map((c) => lowerFirst(sentence(c.quote))).join("; ");
  // Questions still open go down with the decision, so the read-back says so (issue #47).
  const open = openQuestions(l);
  const ask = open.length ? ` I'll also ask the agent: ${open.map((q) => `“${q}”`).join(" ")}` : "";
  if (o.kind === "option") {
    const label = lowerFirst(d.options.find((x) => x.key === o.key)!.label);
    return `So: ${label}${conds ? `, ${conds}` : ""}.${ask} Right?`;
  }
  if (o.kind === "other") return `So: not either option. ${sentence(l.course!.quote)}${conds ? `, ${conds}` : ""}.${ask} Right?`;
  if (o.kind === "rejected") return `So you're rejecting the question: ${sentence(l.course!.quote)}${conds ? `; ${conds}` : ""}. I'll tell the agent.${ask} Right?`;
  if (o.kind === "ask-agent") return `I'll ask the agent: ${o.questions.map(sentence).join("; ")}, and set this aside.`;
  return "Want to set this aside for now?";
}

/**
 * A read-back's own words, from its last sentence starting "So", are bold; anything the model said
 * before them (an answer, "I'll ask the agent") stays plain (issue #48). With no such sentence the
 * whole turn is the read-back.
 */
export function readbackSplit(text: string): [string, string] {
  let at = -1;
  for (const m of text.matchAll(/(^|[.!?;]\s+)So\b/g)) at = m.index! + m[1].length;
  return at > 0 ? [text.slice(0, at), text.slice(at)] : ["", text];
}

/** Code's own plainer restatement, for the stand-in and for a "Huh?" the model left unanswered: the
 *  context's first two sentences, then the choice by its option labels. */
export function plainly(d: Decision): string {
  const choice = ` The choice: ${d.options.map((o) => lowerFirst(sentence(o.label))).join(", or ")}.`;
  // A sentence ends at . ? or ! followed by a space or the end, so "1.2%" stays whole.
  let ctx = (d.context.match(/[\s\S]*?[.?!]+(?=\s|$)/g) ?? [d.context]).slice(0, 2).join("").trim();
  // The choice always fits; the context gives way.
  const room = MAX_EXPLAIN_CHARS - "In plain terms: ".length - choice.length;
  if (ctx.length > room) ctx = `${ctx.slice(0, Math.max(0, room - 1)).trimEnd()}…`;
  return `In plain terms: ${ctx}${choice}`;
}

/** What a read-back commits to: everything that changes what is sent (the choice, the course in
 *  Jordan's words, the conditions, and the questions that would be forwarded to the agent). Any change
 *  to these is a different decision. Reasons are left out: a reason added with a "yes" changes nothing
 *  the agent will do, and is kept with the answer. */
export function decisionFingerprint(l: Ledger): string {
  const open = l.questions.filter((q) => q.answer === null).map((q) => q.quote.quote.trim()).sort();
  return JSON.stringify([l.choice, l.course?.quote.trim() ?? "", l.conditions.map((c) => c.quote.trim()).sort(), open]);
}

/** Bug Me's last turn that wasn't an explanation, if only "Huh?" presses and explanations came after
 *  it (and, when `upTo` is set, before that index): a read-back stays the thing being agreed to. */
export function standingTurn(turns: ConvTurn[], upTo = turns.length): BugTurn | undefined {
  for (let i = upTo - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.who === "bugme" && t.next !== "explain") return t;
    if (t.who === "jordan" && !t.huh) return undefined;
  }
  return undefined;
}

/**
 * Whether Jordan's newest turn only agrees with the last read-back: that read-back committed to
 * exactly this decision (same fingerprint), and the turn clicks nothing and asks nothing. "Yes, but
 * only if…", "yes, without the docs note" or a yes with a different click changes the decision, so it
 * is read back again rather than closed. A "Huh?" and its explanation in between don't count: the yes
 * still answers the read-back.
 */
function agreesOnly(turns: ConvTurn[], ledger: Ledger): boolean {
  const last = standingTurn(turns, turns.length - 1);
  const js = jordanTurns(turns);
  const newest = js.length - 1;
  if (last?.next !== "confirm" || last.heard !== decisionFingerprint(ledger) || js[newest]?.pick) return false;
  return !ledger.questions.some((q) => q.quote.turn === newest);
}

/**
 * Decide what Bug Me does next, given the thread so far (ending with Jordan's newest turn), the
 * model's reply, its `next`, and the verified ledger. Rules, in order:
 * - a "close" counts only when Jordan's newest turn just agrees with the read-back before it (same
 *   choice, no click, nothing new said), and only when the outcome is something that can be sent;
 *   otherwise it becomes a fresh read-back;
 * - an "ask" is allowed while fewer than MAX_CONVERSE_QUESTIONS have been asked and Jordan hasn't
 *   said to stop; otherwise it becomes a read-back;
 * - a model read-back is kept as written;
 * - a "Huh?" is always answered with an explanation (code's own if the model wrote none), and the model
 *   may explain unprompted only when Jordan's newest words say Bug Me wasn't clear ("unclear" feedback);
 *   any other "explain" is treated as an "ask".
 * The reply is trimmed to MAX_REPLY_CHARS (an explanation to MAX_EXPLAIN_CHARS).
 */
export function advance(d: Decision, turns: ConvTurn[], reply: string, next: Next, ledger: Ledger): ConverseResult {
  const last = standingTurn(turns, turns.length - 1);
  const sendable = outcomeOf(d, ledger).kind !== "set-aside";
  const clip = (s: string, max = MAX_REPLY_CHARS) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
  const js = jordanTurns(turns);
  const newest = js.length - 1;
  const confirm = (text: string, forced?: string): ConverseResult => ({ reply: text, next: "confirm", ledger, heard: decisionFingerprint(ledger), ...(forced ? { forced } : {}) });
  const explain = (forced?: string): ConverseResult => ({ reply: clip(!forced && reply.trim() ? reply.trim() : plainly(d), MAX_EXPLAIN_CHARS), next: "explain", ledger, ...(forced ? { forced } : {}) });
  const atLimit = wordTurns(turns) >= MAX_CONVERSE_TURNS || js.reduce((n, t) => n + t.text.length, 0) >= MAX_TRANSCRIPT_CHARS - 40;
  // A press always gets an explanation: the model's when it wrote one, otherwise code's own.
  if (js[newest]?.huh) return next === "explain" && reply.trim() ? explain() : explain("a Huh? answered with something else");
  if (next === "explain") {
    const unclear = ledger.feedback.some((f) => f.kind === "unclear" && f.quote.turn === newest);
    // At the thread's limit only the read-back is left, so a typed "what?" gets that instead.
    if (unclear && atLimit) return confirm(readBack(d, ledger), "thread limit");
    if (unclear) return reply.trim() ? explain() : explain("an empty explanation");
    next = "ask";
  }
  if (next === "close") {
    // The page sends nothing on a typed "yes": it lights the decision button, so the reply says so.
    if (agreesOnly(turns, ledger) && sendable) return { reply: "Got it. Press the button to send it.", next: "close", ledger };
    return confirm(readBack(d, ledger), last?.next !== "confirm" ? "close before a read-back" : !sendable ? "nothing to send yet" : "the decision changed since the read-back");
  }
  if (next === "ask") {
    if (ledger.no_more_questions) return confirm(readBack(d, ledger), "asked to stop asking");
    if (questionsAsked(turns) >= MAX_CONVERSE_QUESTIONS) return confirm(readBack(d, ledger), "question cap");
    // A question Jordan couldn't answer within the thread's limits is never asked.
    if (atLimit) return confirm(readBack(d, ledger), "thread limit");
    return { reply: clip(reply.trim()), next: "ask", ledger };
  }
  // A read-back too long to show whole is replaced by code's, never clipped: Jordan confirms only what was shown.
  const said = reply.trim();
  return confirm(said && said.length <= MAX_REPLY_CHARS ? said : readBack(d, ledger), said.length > MAX_REPLY_CHARS ? "read-back too long" : undefined);
}

/** Everything the close path is given from a confirmed thread, all in Jordan's words. */
export interface CloseInputs {
  outcome: Outcome;
  /** The why quotes joined; "" when none, so the backstop can still ask (unless suppressed below). */
  reason: string;
  /** The condition quotes joined. */
  conditions: string;
  /** Questions the agent's material didn't answer: sent down with a decision (empty for "ask-agent",
   *  where they are the outcome, and for "set-aside"). */
  questions: string[];
  /** For "other" and "rejected": Jordan's words for the course. */
  course: string;
  /** All of Jordan's turns, in order. */
  narration: string;
  /** The why, condition and feedback quotes, whole and in order, within MAX_EVIDENCE_CHARS. */
  evidence: string;
  /** Feedback about the question itself: a reason to propose guidance even on an expected answer.
   *  "Unclear" feedback is about Bug Me's translation, not the decision, so it doesn't count. */
  hasFeedback: boolean;
  /** Times Bug Me's translation missed: "Huh?" presses plus "unclear" feedback (docs/STAGE-6E.md). */
  unclear: number;
  noMoreQuestions: boolean;
}

/** Times Bug Me's translation missed in a thread: each explanation it had to give, plus any "unclear"
 *  feedback in the final reading that wasn't answered with one. Counted from the thread itself, so a
 *  retry adds nothing and a later reading can't drop an earlier miss. */
export function unclearCount(turns: ConvTurn[], l: Ledger | null): number {
  const explained = new Set<number>();
  let j = -1;
  for (const t of turns) {
    if (t.who === "jordan") j++;
    else if (t.next === "explain") explained.add(j);
  }
  return explained.size + (l?.feedback.filter((f) => f.kind === "unclear" && !explained.has(f.quote.turn)).length ?? 0);
}

export function closeInputs(d: Decision, turns: ConvTurn[], l: Ledger): CloseInputs {
  // Quotes are joined verbatim; one that doesn't end a sentence is followed by "; " so two clauses don't run together.
  const glue = (a: string, q: string) => (!a ? q : `${a}${/[.!?;:,]$/.test(a) ? " " : "; "}${q}`);
  const join = (qs: Quote[]) => qs.map((q) => q.quote.trim()).reduce(glue, "");
  // Whole quotes, in order, while they fit.
  let evidence = "";
  const aboutDecision = l.feedback.filter((f) => f.kind !== "unclear");
  for (const q of [...l.why, ...l.conditions, ...aboutDecision.map((f) => f.quote)]) {
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
    questions: ["option", "other", "rejected"].includes(outcomeOf(d, l).kind) ? openQuestions(l) : [],
    course: l.course?.quote.trim() ?? "",
    narration: jordanTurns(turns).map((t) => t.text.trim()).filter(Boolean).join("\n"),
    evidence,
    hasFeedback: aboutDecision.length > 0,
    unclear: unclearCount(turns, l),
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
      if (t.huh) return `${first} [turn ${j++}]: (pressed "Huh?": didn't follow the last thing Bug Me showed)`;
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
      if (o.next !== "ask" && o.next !== "confirm" && o.next !== "close" && o.next !== "explain") throw new ConverseError(`turns[${i}].next must be ask, confirm, close or explain`);
      if (o.text.length > MAX_BUG_TURN_CHARS) throw new ConverseError(`turns[${i}] is too long`);
      if (o.heard !== undefined && (typeof o.heard !== "string" || o.heard.length > MAX_BUG_TURN_CHARS)) throw new ConverseError(`turns[${i}].heard must be a short string`);
      return o.heard !== undefined ? { who: "bugme", text: o.text, next: o.next, heard: o.heard as string } : { who: "bugme", text: o.text, next: o.next };
    }
    if (o.who !== "jordan") throw new ConverseError(`turns[${i}].who must be jordan or bugme`);
    if (o.huh !== undefined) {
      if (o.huh !== true || o.text || o.pick !== undefined) throw new ConverseError(`turns[${i}].huh must be true, with no words and no pick`);
      return { who: "jordan", text: "", huh: true };
    }
    if (o.text.length > MAX_REASON_CHARS) throw new ConverseError(`turns[${i}] is longer than ${MAX_REASON_CHARS} characters`);
    if (o.pick !== undefined && (typeof o.pick !== "string" || !keys.includes(o.pick))) throw new ConverseError(`turns[${i}].pick is not an option of this decision`);
    if (!o.text.trim() && !o.pick) throw new ConverseError(`turns[${i}] has neither words nor a pick`);
    return o.pick ? { who: "jordan", text: o.text, pick: o.pick as string } : { who: "jordan", text: o.text };
  });
  if (turns.at(-1)!.who !== "jordan") throw new ConverseError("the last turn must be Jordan's");
  const js = jordanTurns(turns);
  if (wordTurns(turns) > MAX_CONVERSE_TURNS) throw new ConverseError(`a thread holds at most ${MAX_CONVERSE_TURNS} of Jordan's turns`);
  if (huhs(turns) > MAX_HUH) throw new ConverseError(`a thread holds at most ${MAX_HUH} presses of "Huh?"`);
  if (js.reduce((n, t) => n + t.text.length, 0) > MAX_TRANSCRIPT_CHARS) throw new ConverseError(`a thread holds at most ${MAX_TRANSCRIPT_CHARS} characters of Jordan's words`);
  return { card: { route, why_here }, turns };
}
