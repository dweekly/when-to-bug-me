// What the person's clicks do: answering (check for pushback, then record the final answer and the
// sealed guess), asking why, proposing and keeping guidance, editing rules, undoing a settled call,
// and re-routing waiting decisions under the new guidance. Each step updates state, saves, and
// redraws through views.ts / card.ts.

import { nextInSession } from "../shared/agenda";
import { MAX_CONVERSE_TURNS, MAX_EVIDENCE_CHARS, MAX_FACTS, MAX_REASON_CHARS, MAX_RULE_CHARS, MAX_RULES, MAX_TRANSCRIPT_CHARS, REROUTE_CONCURRENCY } from "../shared/constants";
import { type ConverseResult, type JordanTurn, closeInputs, jordanTurns } from "../shared/converse";
import { guidanceText } from "../shared/parse";
import { type Punt, puntInstruction, puntProblem } from "../shared/punt";
import {
  type GlowEvent,
  type Guess,
  hasBasis,
  keptFact,
  withFact,
  moodAfter,
  nextGlow,
  shouldAskWhy,
  shouldProposeGuidance,
  shouldPushBack,
  substantiveBasis,
} from "../shared/lifecycle";
import type { Card, Decision, FactOutput, Mark, RouteKind, Source } from "../shared/types";
import { api } from "./api";
import { drainVoice } from "./voice";
import { paintThread, renderNow, startPunt } from "./card";
import { ROUTE_LABEL, agenda, reroutableIds, routeOf, waitingIds } from "./derive";
import { announce } from "./dom";
import { go } from "./router";
import { type Flow, type ShownBugTurn, type State, type Thread, F, Q, S, byId, log, newFlow, save, setF, talking } from "./state";
import { render, renderRules, setRuleDraft } from "./views";
import { type Delivery, OWNER_PAGE, deliver, deliveryProblem, saveContext } from "./live";

export function glowEvent(e: GlowEvent): void {
  S.glow = nextGlow(S.glow, e);
  const waiting = agenda().sections.length;
  S.mood = moodAfter(e, S.glow, waiting);
}

/**
 * Every async step below captures the flow that started it. Its results are always recorded against
 * that flow's own decision and choice; the screen is only updated if that flow is still the one in
 * front of the person (they may have opened another card while a request was in flight).
 */
export function showing(flow: Flow): boolean {
  return F === flow;
}

/**
 * Whether the state an async step started in is still the live one. "Start the morning over"
 * replaces S wholesale; a response arriving after that belongs to a morning that no longer exists
 * and must not write into the fresh one.
 */
export function alive(s0: State, flow?: Flow): boolean {
  return S === s0 && (!flow || S.flows[flow.id] === flow);
}

/**
 * The decision conversation (docs/STAGE-6.md). Jordan's turns and Bug Me's replies live in the flow.
 * Each Send posts the whole thread to /api/converse and appends Bug Me's reply; the reply's `next`
 * says whether Bug Me asked something, read the decision back, or (after a typed "yes") closed it.
 * Confirming a read-back with the button sends the decision down the existing answer path without a
 * further call. Updates while typing repaint the card in place (card.ts paintThread).
 */

/** Flows with a turn out (a second click does nothing). */
const sending = new WeakSet<Flow>();

export function isSending(flow: Flow): boolean {
  return sending.has(flow);
}

/** The composer's words changed (typing, or a finished voice phrase). */
export function thinkEdited(flow: Flow, text: string): void {
  if (text === flow.think) return;
  flow.think = text;
  flow.rev++;
  flow.error = "";
  save();
  repaint(flow);
}

/** Click an option: it lights, and travels with the next turn. */
export function pick(flow: Flow, key: string): void {
  if (flow.phase !== "choose" || sending.has(flow)) return;
  flow.pick = key;
  flow.choice = key;
  flow.message = "";
  save();
  repaint(flow);
}

/** Bug Me's last turn, if it read the decision back and nothing has been said or clicked since. */
export function readyToConfirm(flow: Flow): boolean {
  const last = flow.turns.at(-1);
  return last?.who === "bugme" && last.next === "confirm" && !flow.think.trim() && !flow.pick && Boolean(flow.ledger);
}

/** Jordan's last turn never got a reply (a failure, or a reload while it was out): Send asks again. */
export function unanswered(flow: Flow): boolean {
  return flow.turns.at(-1)?.who === "jordan" && !sending.has(flow);
}

/** Which of Jordan's scripted turns comes next: an unanswered turn is still the current one. */
export function scriptIndex(flow: Flow): number {
  const n = jordanTurns(flow.turns).length;
  return flow.turns.at(-1)?.who === "jordan" ? n - 1 : n;
}

function repaint(flow: Flow): void {
  if (showing(flow)) paintThread();
}

/** The routed card the conversation is about, captured when it starts and used to the end. */
function threadCard(flow: Flow, d: Decision): Card | null {
  if (!flow.card && isCardLike(S.cards[d.id])) flow.card = S.cards[d.id] as Card;
  return flow.card;
}

/**
 * Send Jordan's words (and any click) as a turn, or ask again for a reply that never came. Claimed at
 * once; the microphone finishes its phrase first; a reply is applied only to the thread it answers.
 */
export async function sendTurn(flow: Flow, d: Decision, route: RouteKind): Promise<void> {
  if (flow.phase !== "choose" || sending.has(flow)) return;
  // A turn that never got a reply is asked again as it was, unless the person has since changed the
  // words or the pick: then the new input replaces it.
  if (unanswered(flow) && (flow.think.trim() || flow.pick)) {
    const old = flow.turns.pop() as JordanTurn;
    if (!flow.pick && old.pick) flow.pick = old.pick;
  }
  const retry = unanswered(flow);
  sending.add(flow);
  const s0 = S;
  let left = false;
  const leave = () => (left = true);
  window.addEventListener("hashchange", leave);
  const still = () => !left && alive(s0, flow) && flow.phase === "choose";
  flow.message = "";
  flow.error = "";
  repaint(flow);
  let turn: JordanTurn | null = null;
  try {
    await drainVoice();
    if (!still()) return;
    const card = threadCard(flow, d);
    if (!card) return;
    if (!retry) {
      const text = flow.think.trim();
      if (!text && !flow.pick) return;
      if (text.length > MAX_REASON_CHARS) {
        flow.error = `That's more than ${MAX_REASON_CHARS} characters; the gist is enough.`;
        return;
      }
      if (jordanTurns(flow.turns).length >= MAX_CONVERSE_TURNS || jordanTurns(flow.turns).reduce((n, t) => n + t.text.length, text.length) > MAX_TRANSCRIPT_CHARS) {
        flow.message = "That's plenty to go on. Confirm what Bug Me read back, or skip.";
        return;
      }
      turn = flow.pick ? { who: "jordan", text, pick: flow.pick } : { who: "jordan", text };
      flow.turns.push(turn);
      flow.think = "";
      flow.rev++;
      flow.pick = null;
      log("turn", { id: d.id, text: turn.text, pick: turn.pick });
      save();
      repaint(flow);
    }
    const asked = flow.turns.at(-1) as JordanTurn;
    let r: ConverseResult & { source: Source };
    try {
      r = await api<ConverseResult & { source: Source }>("/api/converse", {
        id: d.id,
        card: { route: card.route ?? route, why_here: card.why_here.slice(0, 600) },
        turns: flow.turns.map((t) => (t.who === "bugme" ? { who: t.who, text: t.text, next: t.next, ...(t.heard ? { heard: t.heard } : {}) } : t)),
        rules: S.rules,
        facts: S.facts,
      });
    } catch (e) {
      if (!alive(s0, flow) || flow.turns.at(-1) !== asked) return;
      flow.message = `Bug Me couldn't reply just now (${(e as Error).message}). Send again to retry.`;
      return;
    }
    // Only onto the thread it answers: a reset morning, a new turn or a left card drops it.
    if (!alive(s0, flow) || flow.turns.at(-1) !== asked) return;
    const bug: ShownBugTurn = { who: "bugme", text: r.reply, next: r.next, source: r.source, ...(r.heard ? { heard: r.heard } : {}) };
    flow.turns.push(bug);
    flow.ledger = r.ledger;
    // The lit option follows what Bug Me heard; a click since then would still win.
    flow.choice = d.options.some((o) => o.key === r.ledger.choice) ? r.ledger.choice : null;
    log("reply", { id: d.id, text: r.reply, next: r.next, choice: r.ledger.choice, forced: r.forced, source: r.source });
    save();
    if (showing(flow)) announce(`Bug Me: ${r.reply}`);
    if (r.next === "close" && still()) {
      // Words typed or spoken while that "yes" was out are a correction: nothing closes until they are sent.
      if (flow.think.trim() || flow.pick) {
        flow.message = "You added something after that yes. Send it, and Bug Me will read the decision back again.";
        return;
      }
      sending.delete(flow);
      await confirmThread(flow, d, route);
    }
  } finally {
    window.removeEventListener("hashchange", leave);
    sending.delete(flow);
    if (showing(flow) && flow.phase === "choose") paintThread();
  }
}

/**
 * The person confirmed what Bug Me read back (the button, or a typed "yes" that closed it). The
 * thread's reading goes down the existing path, in the person's words: an option through pushback,
 * the guess and guidance; their own course or a rejected question recorded as such; open questions
 * to the agent; nothing decided, the Skip panel.
 */
export async function confirmThread(flow: Flow, d: Decision, route: RouteKind): Promise<void> {
  if (flow.phase !== "choose" || sending.has(flow) || !flow.ledger) return;
  // Claimed at once; the microphone finishes its phrase first. Anything said or typed by then is a new
  // turn for Bug Me to read back, not part of the decision already read back.
  sending.add(flow);
  const s0 = S;
  try {
    await drainVoice();
  } finally {
    sending.delete(flow);
  }
  if (!alive(s0, flow) || flow.phase !== "choose" || !flow.ledger) return;
  if (flow.think.trim() || flow.pick) {
    flow.message = "You added something. Send it, and Bug Me will read the decision back again.";
    repaint(flow);
    return;
  }
  const ci = closeInputs(d, flow.turns, flow.ledger);
  flow.basis = ci.reason;
  flow.conditions = ci.conditions;
  flow.evidence = ci.evidence;
  flow.whyAsked = ci.whyAsked;
  flow.noMoreQuestions = ci.noMoreQuestions;
  flow.hasFeedback = ci.hasFeedback;
  const n: Narration = { narration: ci.narration, narrationMarks: [], unparsed: false };
  flow.narration = n;
  const o = ci.outcome;
  if (o.kind === "set-aside") return startPunt(flow);
  // Claimed before any await (on /me each of these waits for the asking session), so a second press does nothing.
  sending.add(flow);
  try {
    if (o.kind === "ask-agent") return await sendQuestionToAgent(flow, d, o.questions);
    if (o.kind === "other" || o.kind === "rejected") return await chooseOutside(flow, d, route, o.kind, ci.course, n);
    flow.choice = o.key;
    threadCard(flow, d);
    await answer(flow, d, route, n);
  } finally {
    sending.delete(flow);
    // A press that ended back on the card (a delivery that failed) re-enables its buttons.
    if (flow.phase === "choose" && showing(flow)) repaint(flow);
  }
}

/** The person's words as kept with the answer. `unparsed`: they couldn't be read, so they go down whole. */
export interface Narration {
  narration: string;
  narrationMarks: Mark[];
  unparsed: boolean;
}

/**
 * Live queue only (docs/STAGE-7.md): deliver an outcome to the asking session and say whether it got
 * there. On failure the card says why, in `message` (decision buttons) or `error` (a panel's own
 * text box), and stays where it was for another press. Always true off /me.
 */
async function delivered(flow: Flow, id: string, d: Delivery, where: "message" | "error" = "message"): Promise<boolean> {
  if (!OWNER_PAGE) return true;
  try {
    await deliver(id, d);
    return true;
  } catch (e) {
    if (where === "error") flow.error = deliveryProblem(e);
    else {
      if (flow.phase === "busy") flow.phase = "choose";
      flow.message = deliveryProblem(e);
    }
    if (showing(flow)) renderNow();
    return false;
  }
}

const threadOf = (flow: Flow): Thread | undefined => (flow.ledger ? { turns: flow.turns, ledger: flow.ledger } : undefined);

/**
 * A course of the person's own ("other"), or the question itself rejected: recorded as such, in their
 * words, and told to the agent (simulated). Bug Me's sealed guess stays sealed: it only ever guessed
 * among the listed options. A why or feedback can still become guidance.
 */
export async function chooseOutside(flow: Flow, d: Decision, route: RouteKind, kind: "other" | "rejected", course: string, n: Narration): Promise<void> {
  const basis = flow.basis.trim();
  const conditions = flow.conditions.trim();
  const first = Q.persona.first_name;
  const send_down =
    kind === "other"
      ? `${first} chose neither option. Instead: ${course}${conditions ? ` Conditions: ${conditions}` : ""}`
      : `${first} rejected the question as asked: ${course}`;
  // Live queue only (docs/STAGE-7.md): the asking session hears it now, or nothing is recorded and the card stays open.
  if (!(await delivered(flow, d.id, { outcome: kind, course, reason: basis, conditions, instruction: send_down }))) return;
  const thread = threadOf(flow);
  S.answered[d.id] = { initial: kind, final: kind, other: course, outcome: kind, basis, guess: [], route, pushback: null, send_down, marks: [], narration: n.narration, narrationMarks: n.narrationMarks, ...(conditions ? { conditions } : {}), ...(thread ? { thread } : {}) };
  log("answer", { id: d.id, route, initial: kind, final: kind, outcome: kind, other: course, basis, conditions: conditions || undefined, narration: n.narration, guess_before_answer: null, source: isCardLike(S.cards[d.id]) ? (S.cards[d.id] as Card).source : null });
  glowEvent({ kind: "answered", route, basis: substantiveBasis(basis || course), againstRecommendation: true });
  flow.choice = kind;
  flow.send_down = send_down;
  if (flow.evidence && (basis || flow.hasFeedback)) {
    void propose(flow, d);
    return;
  }
  done(flow, "");
}

const isCardLike = (c: unknown): boolean => Boolean(c) && typeof c === "object" && "source" in (c as object);

/** Questions the agent's material didn't answer go back to the asking agent, and the decision waits. */
export async function sendQuestionToAgent(flow: Flow, d: Decision, questions: string[]): Promise<void> {
  const question = questions.join(" ").replace(/\s+/g, " ").trim();
  const punt: Punt = { id: d.id, kind: "info", reason: question, at: new Date().toISOString(), instruction: puntInstruction("info", question, Q.persona.first_name) };
  // Live queue only: the session is told what to find out, and the ticket is set aside (so it can be resumed).
  if (!(await delivered(flow, d.id, { outcome: "set-aside", kind: "info", reason: punt.reason, instruction: punt.instruction }))) return;
  S.punts[d.id] = punt;
  log("punt", { id: d.id, reason_kind: punt.kind, reason: punt.reason, instruction: punt.instruction, from_phase: "ask", thread: threadOf(flow) });
  glowEvent({ kind: "punted" });
  delete S.flows[d.id];
  announce(`Set aside. The agent was asked: ${punt.instruction}`);
  window.dispatchEvent(new CustomEvent("bugme:set-aside", { detail: { id: d.id } }));
  next();
}

export async function answer(flow: Flow, d: Decision, route: RouteKind, n: Narration): Promise<void> {
  if (!flow.choice) return;
  const choice = flow.choice;
  const s0 = S;
  // The card is captured now: a re-route finishing mid-answer must not swap the sealed guess.
  const c = (flow.card = S.cards[d.id] as Card);
  flow.narration = n;
  flow.initial = choice;
  flow.phase = "busy";
  flow.message = "Checking against your record…";
  renderNow();
  try {
    const r = await api<{ pushback: string | null }>("/api/answer", { id: d.id, sealed: c.sealed, choice, stage: "check" });
    if (!alive(s0, flow)) return;
    if (shouldPushBack(r.pushback, S.pushbacksUsed)) {
      S.pushbacksUsed++;
      flow.pushback = r.pushback;
      flow.phase = "pushback";
      log("pushback", { id: d.id, choice, quoted: r.pushback });
      save();
      if (showing(flow)) renderNow();
      return;
    }
    await finalize(flow, d, route, choice, null);
  } catch (e) {
    if (!alive(s0, flow)) return;
    flow.phase = "choose";
    flow.message = `Something went wrong: ${(e as Error).message}`;
    if (showing(flow)) renderNow();
  }
}

export async function finalize(flow: Flow, d: Decision, route: RouteKind, choice: string, pushbackOutcome: "kept" | "changed" | null): Promise<void> {
  const s0 = S;
  const c = flow.card ?? (S.cards[d.id] as Card);
  flow.choice = choice;
  flow.phase = "busy";
  if (showing(flow)) renderNow();
  let r: { guess: Guess; send_down: string };
  try {
    r = await api<{ guess: Guess; send_down: string }>("/api/answer", { id: d.id, sealed: c.sealed, choice, stage: "final" });
  } catch (e) {
    if (!alive(s0, flow)) return;
    flow.phase = "choose";
    flow.message = `Couldn't record that answer: ${(e as Error).message}. Try again.`;
    if (showing(flow)) renderNow();
    return;
  }
  if (!alive(s0, flow)) return;
  const basis = flow.basis.trim();
  // The person's "but…" phrases travel with the answer to the agent, verbatim. Words that couldn't be
  // read go down whole, labeled as such, so nothing they said is lost.
  const conditions = flow.conditions.trim();
  const n = flow.narration ?? undefined;
  const send_down = [
    r.send_down,
    conditions ? `Conditions from ${Q.persona.first_name}: ${conditions}` : "",
    n?.unparsed ? `${Q.persona.first_name}'s words, as said: “${n.narration}”` : "",
  ].filter(Boolean).join(" ");
  // Live queue only: the asking session hears it now, or nothing is recorded (and the guess stays hidden)
  // and the card stays open for another press.
  if (!(await delivered(flow, d.id, { outcome: "option", choice, reason: basis, conditions, instruction: send_down }))) return;
  if (!alive(s0, flow)) return;
  flow.guess = r.guess;
  flow.send_down = send_down;
  S.answered[d.id] = {
    initial: flow.initial ?? choice,
    final: choice,
    basis,
    guess: r.guess,
    route,
    pushback: flow.pushback,
    send_down,
    marks: [],
    ...(conditions ? { conditions } : {}),
    ...(n?.narration ? { narration: n.narration, narrationMarks: n.narrationMarks } : {}),
    ...(flow.ledger ? { outcome: "option" as const, thread: { turns: flow.turns, ledger: flow.ledger } } : {}),
  };
  log("answer", {
    id: d.id,
    route,
    initial: flow.initial,
    final: choice,
    basis,
    guess_before_answer: r.guess,
    pushback: flow.pushback,
    pushback_outcome: pushbackOutcome,
    conditions: conditions || undefined,
    narration: n?.narration || undefined,
    source: c.source,
  });
  glowEvent({ kind: "answered", route, basis: substantiveBasis(basis), againstRecommendation: choice !== d.recommended });
  save();
  // The conversation already asked (or was told to stop asking): the backstop stays quiet.
  if (shouldAskWhy(choice, r.guess, guidanceText({ reason: basis, conditions }), { whyAsked: flow.whyAsked, noMoreQuestions: flow.noMoreQuestions })) {
    flow.phase = "why";
    save(); // saved before it is shown, so a reload keeps the question
    if (showing(flow)) {
      render();
      (document.getElementById("why") as HTMLTextAreaElement | null)?.focus();
    }
    return;
  }
  // Conditions on an answer, and feedback about the question itself, are new information even when
  // the choice matches the guess.
  if (conditions || flow.hasFeedback || shouldProposeGuidance(choice, d.recommended, r.guess, basis)) {
    await propose(flow, d);
    return;
  }
  done(flow, "");
}

/** A reason given after the answer was final (the why prompt) is added to the record and the answer. */
export function recordLateReason(d: Decision, basis: string): void {
  const a = S.answered[d.id];
  if (!a || a.basis === basis) return;
  a.basis = basis;
  for (let i = S.record.length - 1; i >= 0; i--) {
    const ev = S.record[i];
    if (ev.kind === "answer" && ev.id === d.id) {
      ev.basis = basis;
      ev.basis_given_after_reveal = true;
      break;
    }
  }
  log("reason", { id: d.id, basis, after_answer: true });
  glowEvent({ kind: "answered", route: a.route, basis: substantiveBasis(basis), againstRecommendation: a.final !== d.recommended });
}

/** Flows with a late reason out (the why panel's button): a second press does nothing. */
const whySending = new WeakSet<Flow>();

export async function propose(flow: Flow, d: Decision): Promise<void> {
  // Only the why panel's own press needs claiming; from finalize, the answer's claim already covers it.
  if (flow.phase !== "why") return proposeNow(flow, d);
  if (whySending.has(flow)) return;
  whySending.add(flow);
  try {
    await proposeNow(flow, d);
  } finally {
    whySending.delete(flow);
  }
}

async function proposeNow(flow: Flow, d: Decision): Promise<void> {
  const s0 = S;
  const phase0 = flow.phase;
  await drainVoice(); // the last words of a spoken reason belong to it
  // Skipped, or already sent by an earlier click, while the phrase finished: nothing more to do.
  if (!alive(s0, flow) || flow.phase !== phase0) return;
  const basis = flow.basis.trim();
  // Guidance is proposed from the person's words: the conversation's why, condition and feedback
  // quotes, or (after "I'm curious: why?") the reason just given with the conditions.
  const evidence = phase0 !== "why" && flow.evidence ? flow.evidence : guidanceText({ reason: basis, conditions: flow.conditions.trim() });
  if (!hasBasis(evidence)) {
    done(flow, "");
    return;
  }
  if (evidence.length > MAX_EVIDENCE_CHARS) {
    flow.phase = flow.phase === "busy" ? "why" : flow.phase;
    flow.error = `Please keep it under ${MAX_EVIDENCE_CHARS} characters (it's ${evidence.length}); the gist is enough.`;
    if (showing(flow)) renderNow();
    return;
  }
  flow.error = "";
  if (basis && S.answered[d.id]?.outcome !== "other" && S.answered[d.id]?.outcome !== "rejected") {
    // Live queue only: a reason given after the answer joins what the asking session has; if it can't, the why stays open.
    if (phase0 === "why" && flow.choice && !(await delivered(flow, d.id, { outcome: "option", choice: flow.choice, reason: basis }, "error"))) return;
    if (!alive(s0, flow)) return;
    recordLateReason(d, basis);
  }
  flow.phase = "busy";
  flow.message = "Turning that into guidance…";
  save();
  if (showing(flow)) render();
  try {
    // A course of the person's own, or a rejected question, is never mapped onto a listed option.
    const outside = flow.choice === "other" || flow.choice === "rejected" ? { outcome: flow.choice, course: S.answered[d.id]?.other ?? "" } : {};
    const p = await api<FactOutput & { reroute: string[]; source: Source }>("/api/fact", {
      id: d.id,
      ...(Object.keys(outside).length ? outside : { choice: flow.choice }),
      reason: evidence,
      rules: S.rules,
      facts: S.facts,
      waiting: reroutableIds().filter((x) => x !== d.id),
    });
    if (!alive(s0, flow)) return;
    flow.proposal = p;
    flow.factDraft = p.text;
    flow.phase = "proposal";
    log("guidance_proposed", { id: d.id, kind: p.kind, text: p.text, replaces: p.replaces, reroute: p.reroute, source: p.source });
  } catch (e) {
    if (!alive(s0, flow)) return;
    flow.phase = "done";
    flow.message = `Couldn't turn that into guidance right now (${(e as Error).message}). Your answer and reason are recorded.`;
    // A tour waiting for the guidance step listens for this, so it can say what happened instead of waiting.
    window.dispatchEvent(new CustomEvent("bugme:guidance-failed", { detail: { id: d.id } }));
  }
  save();
  if (showing(flow)) renderNow();
}

/** Why a rule or fact text can't be saved, or "" if it can. Mirrors the Worker's limits. */
export function guidanceProblem(text: string, adding: "rule" | "fact" | null): string {
  if (!text) return "It can't be empty.";
  if (text.length > MAX_RULE_CHARS) return `Keep it under ${MAX_RULE_CHARS} characters (it's ${text.length}).`;
  if (adding === "fact" && S.facts.length >= MAX_FACTS) return `Bug Me holds at most ${MAX_FACTS} standing facts in this demo.`;
  if (adding === "rule" && S.rules.length >= MAX_RULES) return `At most ${MAX_RULES} rules in this demo.`;
  return "";
}

export async function keepFact(flow: Flow, d: Decision, text: string, p: FactOutput & { reroute: string[] }): Promise<void> {
  if (sending.has(flow)) return; // a second press while the first is saving
  sending.add(flow);
  try {
    await keepFactNow(flow, d, text, p);
  } finally {
    sending.delete(flow);
    if (flow.phase === "proposal" && showing(flow)) renderNow();
  }
}

async function keepFactNow(flow: Flow, d: Decision, text: string, p: FactOutput & { reroute: string[] }): Promise<void> {
  const t = text.replace(/\s+/g, " ").trim();
  const problem = guidanceProblem(t, p.kind === "add" ? "fact" : null);
  if (problem) {
    flow.error = problem;
    if (showing(flow)) renderNow();
    return;
  }
  flow.error = "";
  const label = d.options.find((o) => o.key === flow.choice)?.label ?? "";
  // Live queue only: the guidance is saved on the server first (if it isn't, it isn't kept), then added
  // to the session's answer. A retry after a failed update finds it already saved and only updates.
  const already = OWNER_PAGE ? S.facts.find((f) => f.text === t) : undefined;
  const fact = already ?? keptFact(S.facts, p, t, label);
  if (OWNER_PAGE && !already) {
    try {
      await saveContext(S.rules, withFact(S.facts, fact));
    } catch (e) {
      flow.error = `Couldn't save that guidance (${(e as Error).message}). Press Keep it again to retry.`;
      if (showing(flow)) renderNow();
      return;
    }
  }
  if (!already) {
    S.facts = withFact(S.facts, fact);
    S.newFacts.push(fact.id);
    S.version++;
    save();
  }
  if (OWNER_PAGE) {
    const a = S.answered[d.id];
    const update: Delivery = a?.outcome === "other" || a?.outcome === "rejected" ? { outcome: a.outcome, course: a.other, guidance: t } : { outcome: "option", choice: flow.choice!, guidance: t };
    try {
      await deliver(d.id, update);
    } catch (e) {
      flow.error = `The guidance is saved, but couldn't be added to the asking session's answer (${(e as Error).message}). Press Keep it again to retry.`;
      if (showing(flow)) renderNow();
      return;
    }
    if (already) {
      done(flow, `Kept for future asks: “${t}”`);
      return;
    }
  }
  log("guidance_kept", { id: d.id, fact, edited: t !== p.text });
  glowEvent({ kind: "guidance_kept" });
  done(flow, OWNER_PAGE ? `Kept for future asks: “${t}”` : `Kept. Every agent now gets: “${t}”`);
  const s0 = S;
  const changed = await reroute(p.reroute, `because you told me: “${t.replace(/[.\s]+$/, "")}”`);
  if (!alive(s0, flow)) return;
  flow.rerouted = changed;
  save();
  if (showing(flow)) renderNow();
}

export function done(flow: Flow, message: string): void {
  flow.phase = "done";
  flow.message = message;
  save();
  if (showing(flow)) render();
}

/** Open a decision in focus and start (or continue) a session in its project. */
export function startSession(id: string): void {
  S.sessionProject = byId.get(id)?.project ?? null;
  save();
  go({ view: "focus", id });
}

/**
 * The next decision in the focus session: the rest of the current project first, then the next
 * project in agenda order, with a one-screen pause between projects.
 */
export function next(): void {
  if (F && F.phase === "done") delete S.flows[F.id];
  setF(null);
  const from = S.sessionProject;
  const n = nextInSession(agenda(), from);
  save();
  if (n.changedProject && from) go({ view: "between", project: from });
  else if (n.id) go({ view: "focus", id: n.id });
  else go({ view: "home" });
}

/**
 * "Skip": set the decision aside with the person's reason. Allowed before an answer is final
 * (including at pushback). The decision stays unanswered and its guess stays sealed; the agent is told
 * what to gather (simulated). It comes back only when the person resumes it.
 */
export async function setAside(flow: Flow, d: Decision): Promise<void> {
  if (sending.has(flow)) return; // a second press while the first is telling the session
  sending.add(flow);
  try {
    await setAsideNow(flow, d);
  } finally {
    sending.delete(flow);
    if (flow.phase === "punting" && showing(flow)) renderNow();
  }
}

async function setAsideNow(flow: Flow, d: Decision): Promise<void> {
  const s0 = S;
  await drainVoice(); // a reason still being spoken goes with it
  // Left the card while the phrase finished: the set-aside is not made, and Next must not pull them back.
  if (!alive(s0, flow) || flow.phase !== "punting" || !showing(flow)) return;
  const problem = puntProblem(flow.puntKind, flow.puntReason);
  if (problem) {
    flow.error = problem;
    if (showing(flow)) renderNow();
    return;
  }
  const punt: Punt = {
    id: d.id,
    kind: flow.puntKind!,
    reason: flow.puntReason.trim().replace(/\s+/g, " "),
    at: new Date().toISOString(),
    instruction: puntInstruction(flow.puntKind!, flow.puntReason, Q.persona.first_name),
  };
  // Live queue only: the session is told now, or the panel stays open with the reason for another press.
  if (!(await delivered(flow, d.id, { outcome: "set-aside", kind: punt.kind, reason: punt.reason, instruction: punt.instruction }, "error"))) return;
  if (!alive(s0, flow)) return;
  S.punts[d.id] = punt;
  log("punt", { id: d.id, reason_kind: punt.kind, reason: punt.reason, instruction: punt.instruction, from_phase: flow.puntFrom });
  glowEvent({ kind: "punted" });
  // The answer in progress is dropped: nothing was final, and the guess was never revealed.
  delete S.flows[d.id];
  announce(`Set aside. The agent was asked: ${punt.instruction}`);
  window.dispatchEvent(new CustomEvent("bugme:set-aside", { detail: { id: d.id } }));
  next();
}

/** Bring a set-aside decision back to active work; its history stays with it. */
/** Tickets with a Resume out (live queue only): a second press does nothing. */
const resuming = new Set<string>();

export async function resume(id: string): Promise<void> {
  if (resuming.has(id)) return;
  resuming.add(id);
  try {
    await resumeNow(id);
  } finally {
    resuming.delete(id);
  }
}

async function resumeNow(id: string): Promise<void> {
  const punt = S.punts[id];
  if (!punt) return;
  // Live queue only: the session is told the decision is back with the owner; if that fails, nothing changes.
  if (OWNER_PAGE) {
    try {
      await deliver(id, { outcome: "resumed" });
    } catch (e) {
      announce(deliveryProblem(e));
      return;
    }
  }
  (S.puntHistory[id] ??= []).push(punt);
  delete S.punts[id];
  // A decision the person set aside stays theirs: even if a re-route says it could now be settled,
  // resuming brings it back to them, never to "Decided for you".
  if (!S.reopened.includes(id)) S.reopened.push(id);
  S.flows[id] = newFlow(id);
  log("resume", { id, reason_kind: punt.kind, reason: punt.reason });
  startSession(id);
}

export async function undo(id: string): Promise<void> {
  // Live queue only: the session is told to hold off; if that fails, nothing changes.
  if (OWNER_PAGE) {
    try {
      await deliver(id, { outcome: "reopened" });
    } catch (e) {
      announce(deliveryProblem(e));
      return;
    }
  }
  S.reopened.push(id);
  log("undo", { id });
  S.changes[id] = "You undid Bug Me's call, so it's back with you.";
  save();
  render();
  announce("Undone. It's back on your agenda as a quick check-in.");
}

export async function editRule(id: string, text: string): Promise<void> {
  const t = text.replace(/\s+/g, " ").trim();
  const old = S.rules.find((r) => r.id === id);
  if (!old) return;
  if (t === old.text) {
    setRuleDraft(null);
    renderRules();
    return;
  }
  const problem = guidanceProblem(t, null);
  if (problem) {
    setRuleDraft({ id, text, error: problem, focus: true });
    renderRules();
    return;
  }
  const rules = S.rules.map((r) => (r.id === id ? { ...r, text: t } : r));
  // Live queue only: the server holds the owner's rules; the edit is kept only once it has it.
  if (OWNER_PAGE) {
    try {
      await saveContext(rules, S.facts);
    } catch (e) {
      setRuleDraft({ id, text, error: `Couldn't save that rule (${(e as Error).message}). Try again.`, focus: true });
      renderRules();
      return;
    }
  }
  setRuleDraft(null);
  S.rules = rules;
  S.version++;
  log("rule_edited", { rule: id, from: old.text, to: t });
  glowEvent({ kind: "rule_edited" });
  save();
  render();
  await reroute(waitingIds(), `because you edited ${id}: “${t.replace(/[.\s]+$/, "")}”`);
}

/**
 * Re-route decisions under the current rules and facts, noting every change with its cause. A newer
 * edit supersedes an older pass: decisions the older pass had not finished stay pending and are
 * carried into the newer pass (each keeps the cause that first queued it), so nothing is abandoned.
 */
export async function reroute(ids: string[], cause: string): Promise<string[]> {
  const s0 = S;
  const version = S.version;
  for (const id of ids) if (!S.answered[id] && !S.pending.includes(id)) S.pendingCause[id] = cause;
  // A decision the person is talking through is left alone until they finish (docs/STAGE-6.md).
  const todo = [...new Set([...S.pending, ...ids])].filter((id) => !S.answered[id] && !talking(id));
  S.pending = todo;
  save(); // so a reload mid-pass knows these were being re-checked
  render();
  const changedIds: string[] = [];
  let failed = 0;
  const queue = [...todo];
  const worker = async () => {
    while (queue.length) {
      if (S !== s0 || S.version !== version) return; // superseded: a newer pass (or a reset) owns what is left
      const id = queue.shift()!;
      const why = S.pendingCause[id] ?? cause;
      // A conversation started on it since the pass began: leave its card alone.
      const leave = () => {
        S.pending = S.pending.filter((x) => x !== id);
        delete S.pendingCause[id];
      };
      if (talking(id)) {
        leave();
        continue;
      }
      try {
        const card = await api<Card>("/api/route", { id, rules: S.rules, facts: S.facts });
        if (S !== s0 || S.version !== version) return; // answered under older guidance; the newer pass re-checks it
        if (talking(id)) {
          leave();
          save();
          render();
          continue;
        }
        if (S.answered[id]) {
          // The person answered while this re-check was out; their answer stands.
          S.pending = S.pending.filter((x) => x !== id);
          delete S.pendingCause[id];
          continue;
        }
        const before = routeOf(id);
        S.cards[id] = card;
        S.evaluated[id] = true;
        const after = routeOf(id);
        if (before !== after && before && after) {
          changedIds.push(id);
          S.changes[id] = `Moved from “${ROUTE_LABEL[before]}” to “${ROUTE_LABEL[after]}” ${why}.`;
          log("rerouted", { id, from: before, to: after, cause: why, source: card.source });
        } else if (card.fact_quoted && why.includes(card.fact_quoted.replace(/[.\s]+$/, ""))) {
          S.changes[id] = `Now framed by what you said ${why.replace(/^because you told me: /, "")}.`;
          changedIds.push(id); // a changed framing is surfaced too, even when the route stays the same
        } else if (S.changes[id]?.startsWith("Couldn't re-check")) {
          delete S.changes[id];
        }
      } catch (e) {
        if (S !== s0 || S.version !== version) return;
        failed++;
        S.changes[id] = `Couldn't re-check this one under your latest guidance (${(e as Error).message}), so it may be out of date.`;
        log("reroute_failed", { id, cause: why, error: (e as Error).message });
      }
      S.pending = S.pending.filter((x) => x !== id);
      delete S.pendingCause[id];
      save();
      render();
    }
  };
  await Promise.all(Array.from({ length: Math.min(REROUTE_CONCURRENCY, todo.length) }, worker));
  if (S === s0 && S.version === version) {
    save();
    const n = changedIds.length;
    const parts = [n ? `${n} decision${n === 1 ? "" : "s"} re-routed ${cause}.` : "Re-checked; nothing changed route."];
    if (failed) parts.push(`${failed} couldn't be re-checked and may be out of date.`);
    announce(parts.join(" "));
  }
  return changedIds;
}
