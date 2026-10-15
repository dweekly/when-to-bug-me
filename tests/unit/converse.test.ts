// src/shared/converse.ts and its stand-in: the decision as a conversation (docs/STAGE-6.md). The model
// proposes; `advance` decides. These pin the rules code enforces whatever the model says.
import { describe, expect, it } from "vitest";
import { MAX_CONVERSE_QUESTIONS, MAX_CONVERSE_TURNS, MAX_EVIDENCE_CHARS, MAX_EXPLAIN_CHARS, MAX_HUH, MAX_REPLY_CHARS } from "../../src/shared/constants";
import {
  type ConvTurn,
  EMPTY_LEDGER,
  type Ledger,
  type Next,
  advance,
  closeInputs,
  decisionFingerprint,
  outcomeOf,
  parseConverseRequest,
  plainly,
  primaryLabel,
  openQuestions,
  readBack,
  readbackSplit,
  sanitizeLedger,
  transcriptForPrompt,
  unclearCount,
  unverifiedQuotes,
} from "../../src/shared/converse";
import { CONVERSATIONS } from "../../src/shared/examples";
import { fakeConverse } from "../../src/shared/fakeConverse";
import { shouldAskWhy } from "../../src/shared/lifecycle";
import { alsoAskInstruction } from "../../src/shared/punt";
import { conversePrompt } from "../../src/shared/prompts";
import { decision, decisions, facts, persona, rules } from "./helpers";

const api = decision("api-rename"); // A: Rename to account_id, B: Keep user_id
const flight = decision("onsite-flight"); // A: 6:05am flight, B: 9:40am flight
const j = (text: string, pick?: string): ConvTurn => (pick ? { who: "jordan", text, pick } : { who: "jordan", text });
const bug = (text: string, next: Next, heard?: string): ConvTurn => (heard ? { who: "bugme", text, next, heard } : { who: "bugme", text, next });
const L = (o: Partial<Ledger>): Ledger => ({ ...EMPTY_LEDGER, ...o });
const q = (turn: number, quote: string) => ({ turn, quote });

describe("sanitizeLedger", () => {
  const turns = [j("Keep user_id, because integrators parse v1."), bug("Anything else?", "ask"), j("As long as the docs say why.")];
  const raw = (o: Record<string, unknown>) => ({ ...EMPTY_LEDGER, choice_quote: q(0, ""), course: q(0, ""), ...o });

  it("keeps quotes that are in the turn they name, and drops the rest", () => {
    const l = sanitizeLedger(raw({ choice: "B", why: [q(0, "because integrators parse v1"), q(1, "because integrators parse v1"), q(0, "because integrators parse v2")], conditions: [q(1, "As long as the docs say why.")] }), api, turns);
    expect(l.why).toEqual([q(0, "because integrators parse v1")]);
    expect(l.conditions).toEqual([q(1, "As long as the docs say why.")]);
  });

  it("counts unverified quotes in the raw answer, before anything is dropped", () => {
    expect(unverifiedQuotes({ ledger: raw({ why: [q(0, "because integrators parse v2")], conditions: [q(1, "As long as the docs say why.")] }) }, turns)).toBe(1);
  });

  it("other and reject need a verified, non-empty course; otherwise the choice is none", () => {
    expect(sanitizeLedger(raw({ choice: "other", course: q(0, "test both first") }), api, turns).choice).toBe("none");
    expect(sanitizeLedger(raw({ choice: "reject", course: q(0, "") }), api, turns).choice).toBe("none");
    const ok = sanitizeLedger(raw({ choice: "reject", course: q(0, "Keep user_id"), action: "Drop the rename question entirely please" }), api, turns);
    expect(ok.choice).toBe("reject");
    expect(ok.action).toBe("Drop the rename question entirely");
  });

  it("rejects a choice that is not an option key, other, reject or none", () => {
    expect(() => sanitizeLedger(raw({ choice: "C" }), api, turns)).toThrow();
  });

  it("an answer counts only when the model says the material answers it", () => {
    const l = sanitizeLedger(raw({ questions: [{ turn: 0, quote: "Keep user_id", answerable: false, answer: "a guess" }] }), api, turns);
    expect(l.questions[0].answer).toBeNull();
  });
});

describe("advance: the model proposes, code disposes", () => {
  const picked = L({ choice: "B", why: [q(0, "because integrators parse v1")] });

  it("a close before any read-back becomes a read-back that code writes", () => {
    const r = advance(api, [j("Keep user_id, because integrators parse v1")], "Done!", "close", picked);
    expect(r.next).toBe("confirm");
    expect(r.reply).toBe("So: keep user_id. Right?");
    expect(r.forced).toBeTruthy();
  });

  it("a close straight after a read-back of the same choice stands, and every read-back says what it read back", () => {
    expect(advance(api, [j("Keep user_id, because integrators parse v1")], "", "confirm", picked).heard).toBe(decisionFingerprint(picked));
    const r = advance(api, [j("Keep user_id, because integrators parse v1"), bug("So: keep user_id. Right?", "confirm", decisionFingerprint(picked)), j("Yes")], "Sending that now.", "close", picked);
    expect(r).toMatchObject({ next: "close", reply: "Got it. Press the button to send it." });
  });

  it("a yes that changes the decision is read back again, not closed", () => {
    const seen = [j("Keep user_id, because integrators parse v1"), bug("So: keep user_id. Right?", "confirm", decisionFingerprint(picked))];
    // A different click with the yes.
    const clicked = advance(api, [...seen, j("Yes.", "A")], "Sending that now.", "close", L({ choice: "A" }));
    expect(clicked).toMatchObject({ next: "confirm", reply: "So: rename to account_id. Right?", heard: decisionFingerprint(L({ choice: "A" })), forced: "the decision changed since the read-back" });
    // "Yes, but…": a condition from the newest turn.
    const but = advance(api, [...seen, j("Yes, but only if the docs say why.")], "Sending that now.", "close", L({ choice: "B", why: [q(0, "because integrators parse v1")], conditions: [q(1, "but only if the docs say why.")] }));
    expect(but).toMatchObject({ next: "confirm", reply: "So: keep user_id, but only if the docs say why. Right?" });
    // The reviewer's second case: "yes, without the docs note" removes a condition the read-back had.
    const withDocs = L({ choice: "B", conditions: [q(0, "but note account_id in the docs.")] });
    const readWithDocs = [j("Keep user_id, but note account_id in the docs."), bug("So: keep user_id, but note account_id in the docs. Right?", "confirm", decisionFingerprint(withDocs))];
    const removed = advance(api, [...readWithDocs, j("Yes, keep user_id without the docs note.")], "Sending that now.", "close", L({ choice: "B" }));
    expect(removed).toMatchObject({ next: "confirm", reply: "So: keep user_id. Right?" });
    expect(advance(api, [...readWithDocs, j("Yes.")], "Sending that now.", "close", withDocs).next).toBe("close");
    // A yes that also asks something gets an answer and a read-back, not a close.
    expect(advance(api, [...seen, j("Yes. How many integrators?")], "Ok.", "close", L({ ...picked, questions: [{ quote: q(1, "How many integrators?"), answer: null }] })).next).toBe("confirm");
    // A read-back from an older page, with no record of what it read back, can't be closed on.
    expect(advance(api, [j("Keep user_id"), bug("So: keep user_id. Right?", "confirm"), j("Yes")], "Ok.", "close", picked).next).toBe("confirm");
  });

  it("a yes that changes which questions go to the agent is read back again (third review)", () => {
    const two = L({ questions: [{ quote: q(0, "How many integrations read it?"), answer: null }, { quote: q(0, "Does mobile parse it?"), answer: null }] });
    const seen = [j("How many integrations read it? Does mobile parse it?"), bug("I'll ask the agent: How many integrations read it; Does mobile parse it, and set this aside.", "confirm", decisionFingerprint(two))];
    const one = L({ questions: [{ quote: q(0, "How many integrations read it?"), answer: null }] });
    expect(advance(api, [...seen, j("Yes, just ask the first one.")], "Ok.", "close", one)).toMatchObject({ next: "confirm", reply: "I'll ask the agent: How many integrations read it, and set this aside." });
    expect(advance(api, [...seen, j("Yes.")], "Ok.", "close", two).next).toBe("close");
  });

  it("a read-back too long to show is replaced by code's, never clipped (fourth review)", () => {
    const l = L({ choice: "B", conditions: [q(0, "do not deploy before Friday.")] });
    const r = advance(api, [j("Keep user_id, do not deploy before Friday.")], `So: ${"keep user_id and ".repeat(30)}do not deploy before Friday. Right?`, "confirm", l);
    expect(r).toMatchObject({ next: "confirm", reply: "So: keep user_id, do not deploy before Friday. Right?", forced: "read-back too long" });
  });

  it("never asks a question the thread has no room to answer (fourth review)", () => {
    const five = Array.from({ length: 5 }, (_, i) => [j(`Reason ${i}.`), bug("Noted.", "confirm", "x")]).flat();
    const r = advance(api, [...five, j("Actually, keep user_id.")], "Why that one?", "ask", L({ choice: "B" }));
    expect(r).toMatchObject({ next: "confirm", forced: "thread limit" });
  });

  it("a close after a read-back with nothing to send stays a read-back", () => {
    const r = advance(api, [j("Hmm"), bug("Want to set this aside for now?", "confirm"), j("Yes")], "Ok.", "close", L({}));
    expect(r.next).toBe("confirm");
  });

  it(`asks at most ${MAX_CONVERSE_QUESTIONS} questions; Jordan answers the last one, then the read-back is forced`, () => {
    const once = [j("Keep user_id")];
    expect(advance(api, once, "Why that one?", "ask", L({ choice: "B" })).next).toBe("ask");
    const twice = [...once, bug("Why that one?", "ask"), j("Integrators"), bug("Which integrators?", "ask"), j("All of them")];
    const r = advance(api, twice, "And what else?", "ask", L({ choice: "B" }));
    expect(r.next).toBe("confirm");
    expect(r.reply).not.toContain("what else");
    expect(r.forced).toBe("question cap");
  });

  it("stops asking when Jordan says so", () => {
    const r = advance(flight, [j("", "B"), bug("Why that one?", "ask"), j("Just do it.")], "Why though?", "ask", L({ choice: "B", no_more_questions: true }));
    expect(r).toMatchObject({ next: "confirm", reply: "So: 9:40am flight. Right?", forced: "asked to stop asking" });
  });

  it("keeps a model read-back as written, writes one when it is empty, and trims long replies", () => {
    expect(advance(api, [j("Keep user_id")], "So, keep it. Right?", "confirm", picked).reply).toBe("So, keep it. Right?");
    expect(advance(api, [j("Keep user_id")], "  ", "confirm", picked).reply).toBe("So: keep user_id. Right?");
    expect(advance(api, [j("Keep user_id")], "x".repeat(500), "ask", picked).reply.length).toBe(MAX_REPLY_CHARS);
  });
});

describe("read-backs and the primary button, one per outcome", () => {
  it("a listed option, with its conditions", () => {
    const l = L({ choice: "B", conditions: [q(0, "as long as the docs say why.")] });
    expect(readBack(api, l)).toBe("So: keep user_id, as long as the docs say why. Right?");
    expect(primaryLabel(api, l)).toBe("Keep user_id");
  });
  it("other, reject, ask the agent, set aside", () => {
    const other = L({ choice: "other", course: q(0, "Test both with five customers first."), action: "Test both with customers" });
    expect(readBack(api, other)).toBe("So: not either option. Test both with five customers first. Right?");
    // Conditions show on every outcome's read-back, so a condition added with a "yes" is seen before it closes (third review).
    expect(readBack(api, L({ ...other, conditions: [q(1, "only if the tests finish today.")] }))).toBe("So: not either option. Test both with five customers first, only if the tests finish today. Right?");
    expect(readBack(api, L({ choice: "reject", course: q(0, "why rename in v2 at all?"), conditions: [q(1, "unless mobile needs it.")] }))).toBe("So you're rejecting the question: why rename in v2 at all; unless mobile needs it. I'll tell the agent. Right?");
    expect(primaryLabel(api, other)).toBe("Test both with customers");
    const rej = L({ choice: "reject", course: q(0, "why rename in v2 at all?") });
    expect(readBack(api, rej)).toBe("So you're rejecting the question: why rename in v2 at all. I'll tell the agent. Right?");
    expect(primaryLabel(api, rej)).toBe("Reject the question");
    const ask = L({ questions: [{ quote: q(0, "How many integrations read it?"), answer: null }] });
    expect(outcomeOf(api, ask)).toEqual({ kind: "ask-agent", questions: ["How many integrations read it?"] });
    expect(readBack(api, ask)).toBe("I'll ask the agent: How many integrations read it, and set this aside.");
    expect(primaryLabel(api, ask)).toBe("Ask the agent");
    expect(readBack(api, L({}))).toBe("Want to set this aside for now?");
    expect(primaryLabel(api, L({}))).toBe("Skip");
  });
});

describe("a decision with a question the agent's material didn't answer (issue #47)", () => {
  const open = { quote: q(0, "How many integrations read that field directly?"), answer: null };
  const answered = { quote: q(0, "Does mobile parse it?"), answer: "Yes, the iOS app does." };
  const keep = L({ choice: "B", why: [q(0, "Renaming breaks every integrator.")], questions: [open, answered] });

  it("stays a decision, and only the unanswered question is open", () => {
    expect(outcomeOf(api, keep)).toEqual({ kind: "option", key: "B" });
    expect(openQuestions(keep)).toEqual(["How many integrations read that field directly?"]);
  });
  it("code's read-back says the question goes to the agent too, on every outcome that decides", () => {
    expect(readBack(api, keep)).toBe("So: keep user_id. I'll also ask the agent: “How many integrations read that field directly?” Right?");
    expect(readBack(api, L({ ...keep, choice: "other", course: q(0, "Ship both names.") }))).toBe("So: not either option. Ship both names. I'll also ask the agent: “How many integrations read that field directly?” Right?");
    expect(readBack(api, L({ ...keep, choice: "reject", course: q(0, "why rename at all?") }))).toBe("So you're rejecting the question: why rename at all. I'll tell the agent. I'll also ask the agent: “How many integrations read that field directly?” Right?");
  });
  it("hands the open questions to the close path with a decision, and not when they are the outcome", () => {
    expect(closeInputs(api, [j("Keep it. How many integrations read that field directly?")], keep).questions).toEqual(["How many integrations read that field directly?"]);
    expect(closeInputs(api, [j("How many integrations read that field directly?")], L({ questions: [open] })).questions).toEqual([]);
  });
  it("tells the session to find out, and to come back only if it changes the decision", () => {
    expect(alsoAskInstruction(["How many integrations read that field directly?"], "Jordan")).toBe(
      "Jordan also asks: “How many integrations read that field directly?” Find out. If the answer would change this decision, ask Bug Me again with what you found; otherwise mention it in your next update.",
    );
    expect(alsoAskInstruction([], "Jordan")).toBe("");
  });
  it("a question changes what was read back, so a later yes can't skip it", () => {
    expect(decisionFingerprint(keep)).not.toBe(decisionFingerprint(L({ ...keep, questions: [answered] })));
  });
});

describe("readbackSplit: only the read-back itself is bold (issue #48)", () => {
  it("splits at the last sentence starting So", () => {
    expect(readbackSplit("I don't know how many integrations read that field directly; I'll ask the agent. So: keep user_id in v2. Right?")).toEqual([
      "I don't know how many integrations read that field directly; I'll ask the agent. ",
      "So: keep user_id in v2. Right?",
    ]);
    expect(readbackSplit("Fair. So you're rejecting the question. Right?")).toEqual(["Fair. ", "So you're rejecting the question. Right?"]);
  });
  it("keeps the whole turn when it is all read-back, or has no So sentence", () => {
    expect(readbackSplit("So: keep user_id. Right?")).toEqual(["", "So: keep user_id. Right?"]);
    expect(readbackSplit("I'll ask the agent: How many, and set this aside.")).toEqual(["", "I'll ask the agent: How many, and set this aside."]);
    expect(readbackSplit("Also, Sonia agrees. Right?")).toEqual(["", "Also, Sonia agrees. Right?"]);
  });
});

describe("closeInputs: what the close path is given", () => {
  it("reason, conditions and narration in Jordan's words", () => {
    const turns = [j("Keep user_id"), bug("Why that one?", "ask"), j("Because integrators parse v1. As long as docs say why.")];
    const c = closeInputs(api, turns, L({ choice: "B", why: [q(1, "Because integrators parse v1.")], conditions: [q(1, "As long as docs say why.")] }));
    expect(c).toMatchObject({
      outcome: { kind: "option", key: "B" },
      reason: "Because integrators parse v1.",
      conditions: "As long as docs say why.",
      narration: "Keep user_id\nBecause integrators parse v1. As long as docs say why.",
      evidence: "Because integrators parse v1. As long as docs say why.",
      noMoreQuestions: false,
      hasFeedback: false,
    });
  });
  it(`evidence keeps whole quotes, in order, within ${MAX_EVIDENCE_CHARS} characters, feedback included`, () => {
    const long = "a".repeat(500);
    const turns = [j(`${long} ${long} shouldn't have come to me`)];
    const c = closeInputs(api, turns, L({ choice: "B", why: [q(0, long), q(0, long)], feedback: [{ quote: q(0, "shouldn't have come to me"), kind: "routing" }] }));
    expect(c.evidence).toBe(long);
    expect(c.hasFeedback).toBe(true);
    const short = closeInputs(api, [j("why. shouldn't have come to me")], L({ choice: "B", why: [q(0, "why.")], feedback: [{ quote: q(0, "shouldn't have come to me"), kind: "routing" }] }));
    expect(short.evidence).toBe("why. shouldn't have come to me");
  });
  it("after the reveal, Bug Me nudges for a reason against the agent or a confident guess, unless told to stop (docs/STAGE-6F.md)", () => {
    const guess = [{ option: "A", p: 0.9 }, { option: "B", p: 0.1 }];
    expect(shouldAskWhy("B", guess, "")).toBe(true);
    expect(shouldAskWhy("B", guess, "", { noMoreQuestions: true })).toBe(false);
    // Bug Me guessed right, but the agent would have picked otherwise: still a nudge.
    const right = [{ option: "B", p: 0.9 }, { option: "A", p: 0.1 }];
    expect(shouldAskWhy("B", right, "")).toBe(false);
    expect(shouldAskWhy("B", right, "", { recommended: "A" })).toBe(true);
    expect(shouldAskWhy("B", right, "", { recommended: "B" })).toBe(false);
    expect(shouldAskWhy("B", right, "Customers hate corrections.", { recommended: "A" })).toBe(false);
  });
});

describe("parseConverseRequest: the projection the model sees", () => {
  const body = (o: Record<string, unknown> = {}) => ({ id: "api-rename", card: { route: "decide", why_here: "Your rule says API changes are yours.", sealed: "SECRET-SEAL", source: "live" }, turns: [j("Keep user_id")], ...o });
  it("keeps only the card's route and reason, never the seal or the source", () => {
    const r = parseConverseRequest(body(), api);
    expect(r.card).toEqual({ route: "decide", why_here: "Your rule says API changes are yours." });
    const prompt = conversePrompt(persona, rules, facts, api, r.card, r.turns);
    expect(prompt).not.toContain("SECRET-SEAL");
    expect(conversePrompt(persona, rules, facts, api, parseConverseRequest(body({ card: { route: "decide", why_here: "Your rule says API changes are yours.", sealed: "other", source: "recorded" } }), api).card, r.turns)).toBe(prompt);
  });
  it("carries what a read-back read back, and refuses an oversized one", () => {
    const r = parseConverseRequest(body({ turns: [j("Keep user_id"), bug("So: keep user_id. Right?", "confirm", '["B","",[]]'), j("Yes")] }), api);
    expect(r.turns[1]).toEqual({ who: "bugme", text: "So: keep user_id. Right?", next: "confirm", heard: '["B","",[]]' });
    expect(() => parseConverseRequest(body({ turns: [j("Keep user_id"), bug("So?", "confirm", "x".repeat(3001)), j("Yes")] }), api)).toThrow(/heard/);
  });
  it("keeps Jordan's words exactly, and a click as a pick, never as a quote", () => {
    const r = parseConverseRequest(body({ turns: [j("  Keep it  ", "B")] }), api);
    expect(r.turns[0]).toEqual({ who: "jordan", text: "  Keep it  ", pick: "B" });
    expect(conversePrompt(persona, rules, facts, api, r.card, r.turns)).toContain('(clicked option B, "Keep user_id")');
  });
  it("refuses what would break the thread", () => {
    expect(() => parseConverseRequest(body({ turns: [j("hi"), bug("Why?", "ask")] }), api)).toThrow(/last turn/);
    expect(() => parseConverseRequest(body({ turns: [j("hi", "C")] }), api)).toThrow(/pick/);
    expect(() => parseConverseRequest(body({ turns: [j("   ")] }), api)).toThrow(/neither/);
    expect(() => parseConverseRequest(body({ turns: Array.from({ length: 7 }, () => j("x")) }), api)).toThrow(/at most 6/);
    expect(() => parseConverseRequest(body({ turns: Array.from({ length: 5 }, () => j("x".repeat(500))) }), api)).toThrow(/2400/);
    expect(() => parseConverseRequest(body({ turns: [j("x".repeat(601))] }), api)).toThrow(/600/);
  });
  it("the largest thread's prompt fits the per-call spend reservation (under 8k tokens, about 24k characters)", () => {
    const big = decisions.reduce((a, b) => (JSON.stringify(a).length > JSON.stringify(b).length ? a : b));
    const turns: ConvTurn[] = [];
    for (let i = 0; i < 6; i++) turns.push(j("x".repeat(400)), bug("y".repeat(i < 5 ? 300 : 3000), i < 5 ? "ask" : "confirm"));
    turns.pop();
    expect(conversePrompt(persona, rules, facts, big, { route: "decide", why_here: "z".repeat(600) }, turns).length).toBeLessThan(24_000);
  });
});

/** The stand-in's answer, checked and advanced exactly as the Worker does. */
function fake(d: typeof api, turns: ConvTurn[]) {
  const raw = fakeConverse(d, turns);
  return advance(d, turns, raw.reply, raw.next, sanitizeLedger(raw.ledger, d, turns));
}

describe("fakeConverse, the labeled stand-in", () => {
  it("a bare option label gets one light why", () => {
    expect(fake(api, [j("Keep user_id.")])).toMatchObject({ next: "ask", reply: "Why that one?" });
  });
  it("a click with no words gets the why too", () => {
    expect(fake(api, [j("", "B")])).toMatchObject({ next: "ask", ledger: { choice: "B" } });
  });
  it("a reason with a resolvable choice gets the read-back", () => {
    const r = fake(api, [j("Keep user_id, because integrators parse v1, as long as the docs say why.")]);
    expect(r.next).toBe("confirm");
    expect(r.reply).toBe("So: keep user_id, as long as the docs say why. Right?");
  });
  it("a question with no choice is passed to the agent", () => {
    expect(fake(api, [j("How many integrations read it?")])).toMatchObject({ next: "ask", reply: "I don't know; I'll ask the agent. Which way are you leaning?" });
  });
  it('"yes" closes only straight after a read-back, and only a plain yes', () => {
    const t = [j("Keep user_id, because integrators parse v1.")];
    const r = fake(api, t);
    const seen = [...t, bug(r.reply, r.next, r.heard)];
    expect(fake(api, [...seen, j("Yes.")]).next).toBe("close");
    expect(fake(api, [j("Yes.")]).next).not.toBe("close");
    // The reviewer's cases: a yes with a different click, and a yes with a new condition.
    expect(fake(api, [...seen, j("Yes.", "A")])).toMatchObject({ next: "confirm", ledger: { choice: "A" } });
    expect(fake(api, [...seen, j("Yes, but only if the docs say why.")]).next).toBe("confirm");
  });
  it('"neither, …" is another course; "why are we … at all" rejects the question', () => {
    expect(fake(api, [j("Neither, test both with five customers first.")]).ledger).toMatchObject({ choice: "other", course: { quote: "test both with five customers first." } });
    // A "neither" that rejects the premise is a rejection, not another course (fourth review).
    expect(fake(api, [j("Neither; why are we renaming in v2 at all?")]).ledger).toMatchObject({ choice: "reject" });
    expect(fake(api, [j("Why are we renaming anything in v2 at all?")]).ledger.choice).toBe("reject");
  });
  it("feedback about the question is captured", () => {
    expect(fake(api, [j("Keep user_id. This shouldn't have come to me.")]).ledger.feedback).toEqual([{ quote: q(0, "This shouldn't have come to me."), kind: "routing" }]);
  });
  it("a correction starting with 'actually' replaces the earlier reasons and conditions", () => {
    const t = [j("Keep user_id, because integrators parse v1, as long as the docs say why."), bug("So: keep user_id, as long as the docs say why. Right?", "confirm"), j("Actually, keep user_id.")];
    expect(fake(api, t).ledger).toMatchObject({ choice: "B", conditions: [], why: [] });
  });
});

describe("the tours' scripted conversations", () => {
  // Whether live Claude follows them is checked on the recording (recorded.test.ts); the stand-in is
  // keyword matching and can't read Jordan's natural phrasing.
  for (const s of CONVERSATIONS) {
    it(`${s.id}${s.variant ? ` (${s.variant})` : ""}: one expectation per turn, real picks, ending at a read-back`, () => {
      const d = decision(s.id);
      expect(s.expect).toHaveLength(s.turns.length);
      expect(s.expect.at(-1)).toBe("confirm");
      expect(d.options.map((o) => o.key)).toContain(s.choice);
      for (const t of s.turns) {
        if (t.pick) expect(d.options.map((o) => o.key)).toContain(t.pick);
        expect(t.text.trim() || t.pick || t.huh).toBeTruthy();
        if (t.huh) expect(t.text).toBe("");
      }
    });
  }
});

describe("joining Jordan's quotes", () => {
  it("adds '; ' between two clauses that don't end a sentence, and nothing else", () => {
    const c = closeInputs(api, [j("one page, so people see it; tabs would hide it.")], L({ choice: "B", why: [q(0, "so people see it"), q(0, "tabs would hide it.")] }));
    expect(c.reason).toBe("so people see it; tabs would hide it.");
    expect(c.evidence).toBe("so people see it; tabs would hide it.");
  });
});

describe('"Huh?" (docs/STAGE-6E.md)', () => {
  const huh: ConvTurn = { who: "jordan", text: "", huh: true };
  const card = { route: "decide", why_here: "Your rule says so." };
  const wire = (turns: ConvTurn[]) => ({ card, turns });

  it("answers a press with the model's explanation, or code's own when the model did something else", () => {
    const r = advance(api, [huh], "Plainly: the field is what integrators read. Rename it, or keep it?", "explain", EMPTY_LEDGER);
    expect(r).toMatchObject({ next: "explain", reply: "Plainly: the field is what integrators read. Rename it, or keep it?" });
    expect(r.forced).toBeUndefined();
    for (const next of ["ask", "confirm", "close"] as const) {
      const o = advance(api, [huh], "Sending that now.", next, EMPTY_LEDGER);
      expect(o, next).toMatchObject({ next: "explain", reply: plainly(api) });
      expect(o.forced, next).toBeTruthy();
    }
    // Two questions already asked: the cap doesn't stop an explanation, and it isn't counted as one.
    const capped = [j("", "B"), bug("Why?", "ask"), j("Hmm."), bug("Why that one?", "ask"), huh];
    expect(advance(api, capped, "In plain terms…", "explain", L({ choice: "B" })).next).toBe("explain");
  });

  it("writes code's own explanation when the model wrote none, and clips a long one", () => {
    expect(advance(api, [huh], "  ", "explain", EMPTY_LEDGER).reply).toBe(plainly(api));
    const long = advance(api, [huh], "x".repeat(MAX_EXPLAIN_CHARS + 50), "explain", EMPTY_LEDGER).reply;
    expect(long.length).toBe(MAX_EXPLAIN_CHARS);
    expect(MAX_EXPLAIN_CHARS).toBeGreaterThan(MAX_REPLY_CHARS);
  });

  it("lets the model explain unprompted only when the newest words say Bug Me wasn't clear", () => {
    const turns = [j("I don't follow. What's a field?")];
    const unclear = L({ feedback: [{ quote: q(0, "I don't follow."), kind: "unclear" }] });
    expect(advance(api, turns, "A field is a name in the response…", "explain", unclear).next).toBe("explain");
    expect(advance(api, turns, "Which way are you leaning?", "explain", EMPTY_LEDGER).next).toBe("ask");
    // Once the questions are used up, an unearned explanation becomes a read-back like any other ask.
    const capped = [j("", "B"), bug("Why?", "ask"), j("Hmm."), bug("Why that one?", "ask"), j("Ok.")];
    expect(advance(api, capped, "Let me explain…", "explain", L({ choice: "B" })).next).toBe("confirm");
  });

  it("a yes after an explanation still answers the read-back it explained; a changed decision is read back", () => {
    const heard = decisionFingerprint(L({ choice: "B" }));
    const turns = [j("Keep user_id."), bug("So: keep user_id. Right?", "confirm", heard), huh, bug("In plain terms…", "explain"), j("Yes.")];
    expect(advance(api, turns, "Sending that now.", "close", L({ choice: "B" })).next).toBe("close");
    expect(advance(api, turns, "Sending that now.", "close", L({ choice: "A" })).next).toBe("confirm");
    // An explanation with no read-back before it: a yes has nothing to agree to.
    expect(advance(api, [huh, bug("In plain terms…", "explain"), j("Yes.")], "Sending that now.", "close", L({ choice: "B" })).next).toBe("confirm");
  });

  it("at the thread's limit, typed confusion gets the read-back, not an explanation", () => {
    const words = Array.from({ length: MAX_CONVERSE_TURNS - 1 }, (_, i) => [j(i === 0 ? "Keep user_id." : `ok ${i}`), bug("So: keep user_id. Right?", "confirm")]).flat();
    const turns = [...words, j("I don't follow.")];
    const l = L({ choice: "B", feedback: [{ quote: q(MAX_CONVERSE_TURNS - 1, "I don't follow."), kind: "unclear" }] });
    expect(advance(api, turns, "Let me explain…", "explain", l)).toMatchObject({ next: "confirm", forced: "thread limit" });
  });

  it("a clarification request is feedback, not a question for the agent or a reason", () => {
    const turns = [j("What does T-19 even mean? Keep it, because customers hate corrections.")];
    const l = sanitizeLedger(
      { ...EMPTY_LEDGER, choice: "B", choice_quote: q(0, ""), course: q(0, ""), feedback: [{ turn: 0, quote: "What does T-19 even mean?", kind: "unclear" }], questions: [{ turn: 0, quote: "What does T-19 even mean?", answerable: false, answer: "" }], why: [q(0, "What does T-19 even mean?"), q(0, "because customers hate corrections")] },
      api,
      turns,
    );
    expect(l.questions).toEqual([]);
    expect(l.why).toEqual([q(0, "because customers hate corrections")]);
    expect(outcomeOf(api, l)).toEqual({ kind: "option", key: "B" });
  });

  it("counts misses from the explanations in the thread, so a later reading can't drop one", () => {
    const turns = [j("I don't follow."), bug("In plain terms…", "explain"), huh, bug("In plain terms…", "explain"), j("Keep user_id.")];
    expect(unclearCount(turns, L({ choice: "B" }))).toBe(2);
    // Unclear feedback that wasn't answered with an explanation still counts.
    expect(unclearCount([j("Keep it. Your summary made no sense.")], L({ feedback: [{ quote: q(0, "Your summary made no sense."), kind: "unclear" }] }))).toBe(1);
  });

  it("code's explanation keeps every option even when the context is long", () => {
    const long = { ...api, context: `${"A very long sentence about the schema migrator ".repeat(30)}. Second.` };
    const p = plainly(long);
    expect(p.length).toBeLessThanOrEqual(MAX_EXPLAIN_CHARS);
    expect(p).toMatch(/The choice: rename to account_id, or keep user_id\.$/);
  });

  it("checks presses on the way in: no words, no pick, at most MAX_HUH, and outside the turn limit", () => {
    expect(parseConverseRequest(wire([huh]), api).turns[0]).toEqual(huh);
    expect(() => parseConverseRequest(wire([{ who: "jordan", text: "hi", huh: true }]), api)).toThrow(/huh/);
    expect(() => parseConverseRequest(wire([{ who: "jordan", text: "", pick: "A", huh: true }]), api)).toThrow(/huh/);
    const presses = (n: number): ConvTurn[] => Array.from({ length: n }, (_, i) => [huh, bug("In plain terms…", "explain")]).flat();
    expect(() => parseConverseRequest(wire([...presses(MAX_HUH), huh]), api)).toThrow(/Huh/);
    const words = Array.from({ length: MAX_CONVERSE_TURNS }, (_, i) => [j(`turn ${i}`), bug("Hm?", "ask")]).flat();
    expect(() => parseConverseRequest(wire([...presses(MAX_HUH), ...words.slice(0, -1)]), api)).not.toThrow();
    expect(() => parseConverseRequest(wire([bug("x", "explain"), j("a")]), api)).not.toThrow();
  });

  it("counts translation misses apart from feedback about the decision", () => {
    const turns = [huh, bug("In plain terms…", "explain"), j("Still makes no sense. Keep user_id, it wasn't urgent.")];
    const l = L({ choice: "B", feedback: [{ quote: q(1, "Still makes no sense."), kind: "unclear" }] });
    const ci = closeInputs(api, turns, l);
    expect(ci.unclear).toBe(2);
    expect(ci.hasFeedback).toBe(false);
    expect(ci.evidence).not.toContain("makes no sense");
    const both = closeInputs(api, turns, L({ ...l, feedback: [...l.feedback, { quote: q(1, "it wasn't urgent."), kind: "priority" }] }));
    expect(both.hasFeedback).toBe(true);
    expect(both.evidence).toContain("it wasn't urgent.");
    expect(sanitizeLedger({ ...EMPTY_LEDGER, choice_quote: q(0, ""), course: q(0, ""), feedback: [{ turn: 1, quote: "Still makes no sense.", kind: "unclear" }] }, api, turns).feedback).toHaveLength(1);
  });

  it("shows the model a press as a press", () => {
    expect(transcriptForPrompt(api, [huh], "Jordan")).toBe('Jordan [turn 0]: (pressed "Huh?": didn\'t follow the last thing Bug Me showed)');
  });

  it("the stand-in explains a press and typed confusion", () => {
    expect(fakeConverse(api, [huh])).toMatchObject({ next: "explain", reply: plainly(api) });
    expect(fakeConverse(api, [j("I don't follow.")]).next).toBe("explain");
    expect(plainly(api)).toMatch(/^In plain terms: .+ The choice: rename to account_id, or keep user_id\.$/);
    expect(plainly(decision("reconciliation-path"))).toContain("(about 1.5% of invoices, mostly by a few cents).");
  });
});
