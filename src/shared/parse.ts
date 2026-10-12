// Thinking out loud: checking the parse of the person's words, a keyword stand-in for it, and what
// the answer path is given from them. Shared by the Worker (checks a parse before it is returned or
// cached), the page (re-checks marks against the words as they are now) and the recorder.

import { MAX_MARKS } from "./constants";
import type { Decision, Mark, ParseOutput } from "./types";

export class ParseError extends Error {}

const KINDS = new Set<Mark["kind"]>(["choice", "why", "but", "ask"]);

/** Where `quote` occurs in `text`, literally (no whitespace or case folding); null if it doesn't. */
export function findQuote(text: string, quote: string): { start: number; end: number } | null {
  if (!quote.trim()) return null;
  const start = text.indexOf(quote);
  return start < 0 ? null : { start, end: start + quote.length };
}

/** The marks that occur in `text`. */
export function presentMarks(text: string, marks: Mark[]): Mark[] {
  return marks.filter((m) => findQuote(text, m.quote));
}

/** The marks to draw, in reading order, without overlaps (the earlier one wins). Drawing only: the
 *  answer path uses every present mark, so a condition inside a long reason is never lost. */
export function drawableMarks(text: string, marks: Mark[]): (Mark & { start: number; end: number })[] {
  const found = marks.flatMap((m) => {
    const at = findQuote(text, m.quote);
    return at ? [{ ...m, ...at }] : [];
  });
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: typeof found = [];
  for (const m of found) if (!out.length || m.start >= out[out.length - 1].end) out.push(m);
  return out;
}

/**
 * Validate a parse beyond its JSON shape: the choice is one of this decision's keys, "other" or
 * "none"; every mark is a literal quote of the words (others are dropped, not fatal: a near-quote is
 * the model's slip, not a reason to lose the rest); at most MAX_MARKS.
 */
export function parseParseOutput(raw: unknown, d: Decision, text: string): ParseOutput {
  if (!raw || typeof raw !== "object") throw new ParseError("not an object");
  const o = raw as Record<string, unknown>;
  const keys = d.options.map((x) => x.key);
  if (typeof o.choice !== "string" || ![...keys, "other", "none"].includes(o.choice)) throw new ParseError("choice is not an option key, other or none");
  if (!Array.isArray(o.marks)) throw new ParseError("marks is not a list");
  const marks: Mark[] = [];
  for (const m of o.marks) {
    if (marks.length >= MAX_MARKS || !m || typeof m !== "object") continue;
    const { kind, quote } = m as Record<string, unknown>;
    if (typeof kind !== "string" || !KINDS.has(kind as Mark["kind"]) || typeof quote !== "string") continue;
    if (findQuote(text, quote)) marks.push({ kind: kind as Mark["kind"], quote });
  }
  let choice = o.choice;
  // "Something else" is told to the agent in the person's words: without them there is nothing to send.
  if (choice === "other" && !marks.some((m) => m.kind === "choice")) choice = "none";
  return { choice, marks: choice === "none" ? marks.filter((m) => m.kind !== "choice") : marks };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The deterministic stand-in for the parse call (tests, local runs without a key). Keyword matching,
 * not judgment. Sentences, and inline "because"/"but"/"as long as" clauses, are split without
 * changing their text. A "?" sentence asks; a clause opening with "but", "as long as", "unless" or
 * "only if" is a condition; one opening with "because" or "since" is a reason; a sentence naming
 * exactly one option's full label, not negated, is the choice ("something else" or "instead" opens a
 * different course). The last choice stated wins and replaces the earlier one's marks; a clause
 * naming both options undoes any earlier choice ("none").
 */
export function fakeParse(d: Decision, text: string): ParseOutput {
  const marks: Mark[] = [];
  let choice = "none";
  /** A newly stated choice replaces the earlier one, marks and all. */
  const dropChoiceMarks = () => {
    for (let i = marks.length - 1; i >= 0; i--) if (marks[i].kind === "choice") marks.splice(i, 1);
  };
  for (const sentence of text.match(/[^.?!]+[.?!]*/g) ?? []) {
    const s = sentence.trim();
    if (!s) continue;
    if (s.endsWith("?")) {
      marks.push({ kind: "ask", quote: s });
      continue;
    }
    const parts = s.split(/(?=,?\s+(?:because|since|but|as long as|unless|only if)\b)/i).map((x) => x.replace(/^,\s*/, "").trim()).filter(Boolean);
    for (const part of parts) {
      const low = part.toLowerCase();
      if (/^(but|as long as|unless|only if)\b/.test(low)) marks.push({ kind: "but", quote: part });
      else if (/^(because|since)\b/.test(low)) marks.push({ kind: "why", quote: part });
      else if (/^(something else|instead)\b/.test(low)) {
        choice = "other";
        dropChoiceMarks();
        marks.push({ kind: "choice", quote: part });
      } else {
        const named = d.options.filter((o) => {
          const m = new RegExp(`(^|[^\\w])${escape(o.label.toLowerCase())}($|[^\\w])`).exec(low);
          return m && !/\b(not|don't|do not|never|no)\s+(\w+\s+)?$/.test(low.slice(0, m.index + m[1].length));
        });
        if (named.length === 1) {
          choice = named[0].key;
          dropChoiceMarks();
          marks.push({ kind: "choice", quote: part });
        } else if (named.length > 1) {
          // Naming both is undecided, and it undoes an earlier choice.
          choice = "none";
          dropChoiceMarks();
        }
      }
    }
  }
  return parseParseOutput({ choice, marks }, d, text);
}

/** What the answer path is given from the person's words, all verbatim. */
export interface AnswerParts {
  /** The "why" phrases joined; "" when none was marked, so "I'm curious: why?" can still ask. */
  reason: string;
  /** The "but" phrases joined: sent down with the answer and given to guidance with the reason. */
  conditions: string;
  /** The different course, for "something else": the choice phrases joined. */
  course: string;
}

export function answerParts(marks: Mark[]): AnswerParts {
  const join = (k: Mark["kind"]) => marks.filter((m) => m.kind === k).map((m) => m.quote.trim()).join(" ");
  return { reason: join("why"), conditions: join("but"), course: join("choice") };
}

/** The text guidance is proposed from: the reason, then the conditions, verbatim. */
export function guidanceText(p: Pick<AnswerParts, "reason" | "conditions">): string {
  return [p.reason, p.conditions].filter(Boolean).join(" ");
}

/** What Send would do now, and the label that says so. */
export type SendPlan =
  | { kind: "nothing"; label: string }
  | { kind: "option"; key: string; label: string }
  | { kind: "other"; label: string }
  | { kind: "ask-agent"; questions: string[]; label: string };

/** "Keep user_id" reads "keep user_id" mid-sentence; "API v2" stays as it is. */
function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/**
 * What Send would do. `choice` is the current pick (a click or the parse); `unanswered` are the
 * questions still in the words that the agent's material came back without an answer for.
 */
export function sendPlan(d: Decision, choice: string | null, marks: Mark[], unanswered: string[]): SendPlan {
  const opt = d.options.find((o) => o.key === choice);
  if (opt) {
    const n = marks.filter((m) => m.kind === "but").length;
    return { kind: "option", key: opt.key, label: `Send: ${lowerFirst(opt.label)}${n ? `, with ${n === 1 ? "one condition" : `${n} conditions`}` : ""}` };
  }
  if (choice === "other" && marks.some((m) => m.kind === "choice")) return { kind: "other", label: "Send: something else" };
  if (unanswered.length) return { kind: "ask-agent", questions: unanswered, label: "Ask the agent, and set this aside" };
  return { kind: "nothing", label: "Send" };
}
