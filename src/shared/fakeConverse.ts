// The deterministic stand-in for the conversation call (tests, local runs without a key). Keyword
// matching over the whole thread, not judgment; it is labeled as the stand-in wherever it shows. It
// returns the same raw shape the model does, so the Worker checks it with the same code (sanitizeLedger,
// advance) as a live answer.

import { type ConvTurn, type Next, bugTurns, jordanTurns } from "./converse";
import { fakeParse } from "./parse";
import type { Decision } from "./types";

type RawQuote = { turn: number; quote: string };
const NONE: RawQuote = { turn: 0, quote: "" };

const NO_MORE = /\b(just do it|no more questions|stop asking|skip it|don't ask)\b/i;
/** A turn that only agrees: nothing else in it. */
const AFFIRM = /^\s*(yes|yep|yeah|right|correct|send it|sounds good|do it)[.!]*\s*$/i;
const REJECT = /\b(wrong question|why are we\b[^.?!]*\bat all|shouldn't even be (?:asking|deciding))/i;
const NEITHER = /^\s*neither\b[,.;:—-]?\s*/i;
const FEEDBACK: [RegExp, "priority" | "routing"][] = [
  [/\b(shouldn't have come to me|should have come to me|you could have decided|didn't need me)\b/i, "routing"],
  [/\b(not urgent|more urgent|less urgent|could have waited)\b/i, "priority"],
];

const sentences = (text: string) => (text.match(/[^.?!]+[.?!]*/g) ?? []).map((s) => s.trim()).filter(Boolean);

export function fakeConverse(d: Decision, turns: ConvTurn[]): { reply: string; next: Next; ledger: Record<string, unknown> } {
  const js = jordanTurns(turns);
  let choice = "none";
  let choice_quote = NONE;
  let course = NONE;
  let why: RawQuote[] = [];
  let conditions: RawQuote[] = [];
  const questions: (RawQuote & { answerable: boolean; answer: string })[] = [];
  const feedback: (RawQuote & { kind: "priority" | "routing" })[] = [];
  let noMore = false;
  js.forEach((t, i) => {
    // "Actually…" starts over: the earlier reasons and conditions no longer apply.
    if (/^\s*actually\b/i.test(t.text)) {
      why = [];
      conditions = [];
    }
    if (t.pick) {
      choice = t.pick;
      choice_quote = NONE;
    }
    const p = fakeParse(d, t.text);
    if (p.choice !== "none") {
      choice = p.choice;
      const q = p.marks.find((m) => m.kind === "choice");
      choice_quote = q ? { turn: i, quote: q.quote } : NONE;
      course = p.choice === "other" && q ? { turn: i, quote: q.quote } : NONE;
    }
    for (const m of p.marks) {
      if (m.kind === "why") why.push({ turn: i, quote: m.quote });
      if (m.kind === "but") conditions.push({ turn: i, quote: m.quote });
      if (m.kind === "ask") questions.push({ turn: i, quote: m.quote, answerable: false, answer: "" });
    }
    for (const s of sentences(t.text)) {
      // Rejecting the premise is checked first: "Neither; why are we … at all?" rejects the question.
      if (REJECT.test(s)) {
        choice = "reject";
        course = { turn: i, quote: s };
        choice_quote = course;
      } else if (NEITHER.test(s) && s.replace(NEITHER, "").trim()) {
        choice = "other";
        course = { turn: i, quote: s.replace(NEITHER, "").trim() };
        choice_quote = course;
      }
      for (const [rx, kind] of FEEDBACK) if (rx.test(s)) feedback.push({ turn: i, quote: s, kind });
    }
    if (NO_MORE.test(t.text)) noMore = true;
  });
  const ledger = {
    choice,
    choice_quote,
    course,
    action: choice === "other" ? "Do something else" : choice === "reject" ? "Reject the question" : "",
    why,
    conditions,
    questions,
    feedback,
    no_more_questions: noMore,
  };
  const latest = js.at(-1);
  const lastBug = bugTurns(turns).at(-1);
  const asked = bugTurns(turns).filter((t) => t.next === "ask").length;
  const decided = d.options.some((o) => o.key === choice) || ((choice === "other" || choice === "reject") && course.quote);
  // The reply is left empty for a read-back: advance writes it from the checked ledger.
  if (latest && !latest.pick && AFFIRM.test(latest.text) && lastBug?.next === "confirm") return { reply: "Sending that now.", next: "close", ledger };
  if (latest && questions.some((q) => q.turn === js.length - 1) && !decided) return { reply: "I don't know; I'll ask the agent. Which way are you leaning?", next: "ask", ledger };
  if (decided && d.options.some((o) => o.key === choice) && !why.length && !noMore && asked === 0) return { reply: "Why that one?", next: "ask", ledger };
  if (decided || noMore) return { reply: "", next: "confirm", ledger };
  return { reply: "Which way are you leaning?", next: "ask", ledger };
}
