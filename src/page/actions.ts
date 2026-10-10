// What the person's clicks do: answering (check for pushback, then record the final answer and the
// sealed guess), asking why, proposing and keeping guidance, editing rules, undoing a settled call,
// and re-routing waiting decisions under the new guidance. Each step updates state, saves, and
// redraws through views.ts / card.ts.

import { nextInSession } from "../shared/agenda";
import { MAX_FACTS, MAX_REASON_CHARS, MAX_RULE_CHARS, MAX_RULES, REROUTE_CONCURRENCY, UNDO_WINDOW_MS } from "../shared/constants";
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
import type { AskOutput, Card, Decision, FactOutput, RouteKind, Source } from "../shared/types";
import { api } from "./api";
import { renderNow } from "./card";
import { ROUTE_LABEL, agenda, routeOf, waitingIds } from "./derive";
import { announce } from "./dom";
import { go } from "./router";
import { type Flow, type State, F, Q, S, byId, log, newFlow, save, setF } from "./state";
import { render, renderRules, setRuleDraft } from "./views";

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
 * The Undo window, in ms. Tests shorten it through localStorage ("bugme.undoMs") so the suite does
 * not wait seconds per answer; the product always uses UNDO_WINDOW_MS.
 */
export function undoWindowMs(): number {
  try {
    const v = Number(localStorage.getItem("bugme.undoMs"));
    return Number.isFinite(v) && localStorage.getItem("bugme.undoMs") !== null && v >= 0 ? v : UNDO_WINDOW_MS;
  } catch {
    return UNDO_WINDOW_MS;
  }
}

/** The one open Undo window, if any: which flow it belongs to and the timer that will send it. */
let pendingAnswer: { flow: Flow; timer: ReturnType<typeof setTimeout> } | null = null;

/**
 * Clicking an option decides. Nothing is sent yet: the flow enters "pending" bound to this card and
 * its sealed guess, the Undo bar shows, and the answer goes out when the window closes, unless the
 * person undoes it, leaves the card, or the card is re-routed in the meantime.
 */
export function choose(flow: Flow, d: Decision, route: RouteKind, key: string): void {
  if (flow.phase !== "choose") return;
  cancelPending();
  const s0 = S;
  const card = S.cards[d.id] as Card;
  flow.choice = key;
  flow.card = card;
  flow.phase = "pending";
  flow.message = "";
  save(); // a reload during the Undo window brings the choice back unsent, with the reason (state.ts)
  renderNow();
  pendingAnswer = {
    flow,
    timer: setTimeout(() => {
      pendingAnswer = null;
      if (!alive(s0, flow) || flow.phase !== "pending") return;
      if (!showing(flow)) {
        flow.phase = "choose";
        flow.message = "Not sent: you left the card before the answer went out.";
        return;
      }
      if (S.cards[d.id] !== card) {
        flow.phase = "choose";
        flow.message = "Not sent: this question was re-checked while you were deciding. Have another look.";
        renderNow();
        return;
      }
      flow.phase = "choose"; // answer() starts from a chosen, unsent card
      void answer(d, route);
    }, undoWindowMs()),
  };
}

/** Undo: the choice is withdrawn before anything was sent; the reason typed so far is kept. */
export function undoChoice(flow: Flow): void {
  if (flow.phase !== "pending") return;
  cancelPending();
  flow.phase = "choose";
  flow.choice = null;
  save();
  announce("Undone. Nothing was sent.");
  renderNow();
}

/** Close any open Undo window without sending (used when the card in front of the person changes). */
export function cancelPending(): void {
  if (!pendingAnswer) return;
  clearTimeout(pendingAnswer.timer);
  const f = pendingAnswer.flow;
  pendingAnswer = null;
  if (f.phase === "pending") {
    f.phase = "choose";
    f.message = "Not sent: you left the card before the answer went out.";
    save();
  }
}

/** Navigation away from the card whose answer is waiting in its Undo window cancels that answer. */
export function cancelPendingUnlessOn(id: string | null): void {
  if (pendingAnswer && pendingAnswer.flow.id !== id) cancelPending();
}

/**
 * "Something else": the person writes their own option. It is recorded as the answer and is what the
 * agent is told (simulated). Bug Me's sealed guess stays sealed: it only ever guessed among A and B.
 */
export function chooseOther(flow: Flow, d: Decision, route: RouteKind): void {
  const text = flow.other.trim().replace(/\s+/g, " ");
  if (text.length < 4) {
    flow.error = "Say what you'd like the agent to do instead.";
    renderNow();
    return;
  }
  if (text.length > MAX_REASON_CHARS) {
    flow.error = `Please keep it under ${MAX_REASON_CHARS} characters.`;
    renderNow();
    return;
  }
  cancelPending();
  flow.error = "";
  const basis = flow.basis.trim();
  const send_down = `${Q.persona.first_name} chose neither option. Instead: ${text}`;
  S.answered[d.id] = { initial: "other", final: "other", other: text, basis, guess: [], route, pushback: null, send_down, marks: [] };
  log("answer", { id: d.id, route, initial: "other", final: "other", other: text, basis, guess_before_answer: null, source: S.cards[d.id] && "source" in S.cards[d.id]! ? (S.cards[d.id] as Card).source : null });
  glowEvent({ kind: "answered", route, basis: substantiveBasis(basis || text), againstRecommendation: true });
  flow.choice = "other";
  flow.send_down = send_down;
  done(flow, "");
}

/** The latest question asked on each card; a response to an earlier one is dropped. */
const askSeq = new Map<string, number>();

/** "Ask a question": Claude answers from what the agent provided, or says what is missing. */
export async function askQuestion(flow: Flow, d: Decision): Promise<void> {
  const q = flow.question.trim();
  const seq = (askSeq.get(flow.id) ?? 0) + 1;
  askSeq.set(flow.id, seq);
  if (q.length < 4) {
    flow.error = "Type or say your question first.";
    renderNow();
    return;
  }
  const s0 = S;
  flow.error = "";
  flow.askAnswer = null;
  flow.message = "Looking at what the agent provided…";
  renderNow();
  try {
    const r = await api<AskOutput & { source: Source }>("/api/ask", { id: d.id, question: q });
    if (!alive(s0, flow) || askSeq.get(flow.id) !== seq || flow.question.trim() !== q) return;
    flow.askAnswer = r;
    flow.message = "";
    log("question", { id: d.id, question: q, answerable: r.answerable, answer: r.answer, source: r.source });
  } catch (e) {
    if (!alive(s0, flow) || askSeq.get(flow.id) !== seq || flow.question.trim() !== q) return;
    flow.askAnswer = { answerable: false, answer: `Couldn't reach Claude for that (${(e as Error).message}).`, source: "code" };
    flow.message = "";
  }
  save();
  if (showing(flow)) renderNow();
}

/** An unanswered question goes back to the asking agent, and the decision waits for the answer. */
export function sendQuestionToAgent(flow: Flow, d: Decision): void {
  // The question was already accepted by Ask, so it is forwarded as is: the set-aside minimum
  // (MIN_PUNT_CHARS, for a reason typed from scratch) does not apply to it.
  const question = flow.question.trim().replace(/\s+/g, " ");
  const punt: Punt = { id: d.id, kind: "info", reason: question, at: new Date().toISOString(), instruction: puntInstruction("info", question, Q.persona.first_name) };
  S.punts[d.id] = punt;
  log("punt", { id: d.id, reason_kind: punt.kind, reason: punt.reason, instruction: punt.instruction, from_phase: "ask" });
  glowEvent({ kind: "punted" });
  delete S.flows[d.id];
  announce(`Set aside. The agent was asked: ${punt.instruction}`);
  window.dispatchEvent(new CustomEvent("bugme:set-aside", { detail: { id: d.id } }));
  next();
}

export async function answer(d: Decision, route: RouteKind): Promise<void> {
  const flow = F;
  if (!flow || !flow.choice) return;
  const choice = flow.choice;
  const s0 = S;
  // The card is captured now: a re-route finishing mid-answer must not swap the sealed guess.
  const c = (flow.card = S.cards[d.id] as Card);
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
  flow.guess = r.guess;
  const basis = flow.basis.trim();
  // "Yes, but…": the conditions travel with the answer to the agent, and count as its reason.
  const conditions = flow.mode === "conditions" && basis ? basis : "";
  const send_down = conditions ? `${r.send_down} Conditions from ${Q.persona.first_name}: ${conditions}` : r.send_down;
  flow.send_down = send_down;
  S.answered[d.id] = { initial: flow.initial ?? choice, final: choice, basis, guess: r.guess, route, pushback: flow.pushback, send_down, marks: [], ...(conditions ? { conditions } : {}) };
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
    source: c.source,
  });
  glowEvent({ kind: "answered", route, basis: substantiveBasis(basis), againstRecommendation: choice !== d.recommended });
  save();
  if (shouldAskWhy(choice, r.guess, basis)) {
    flow.phase = "why";
    save(); // saved before it is shown, so a reload keeps the question
    if (showing(flow)) {
      render();
      (document.getElementById("why") as HTMLTextAreaElement | null)?.focus();
    }
    return;
  }
  // Conditions on an answer are new information even when the choice matches the guess.
  if (conditions || shouldProposeGuidance(choice, d.recommended, r.guess, basis)) {
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

export async function propose(flow: Flow, d: Decision): Promise<void> {
  const s0 = S;
  const basis = flow.basis.trim();
  if (!hasBasis(basis)) {
    done(flow, "");
    return;
  }
  if (basis.length > MAX_REASON_CHARS) {
    flow.phase = flow.phase === "busy" ? "why" : flow.phase;
    flow.error = `Please keep it under ${MAX_REASON_CHARS} characters (it's ${basis.length}); the gist is enough.`;
    if (showing(flow)) renderNow();
    return;
  }
  flow.error = "";
  recordLateReason(d, basis);
  flow.phase = "busy";
  flow.message = "Turning that into guidance…";
  save();
  if (showing(flow)) render();
  try {
    const p = await api<FactOutput & { reroute: string[]; source: Source }>("/api/fact", {
      id: d.id,
      choice: flow.choice,
      reason: basis,
      rules: S.rules,
      facts: S.facts,
      waiting: waitingIds().filter((x) => x !== d.id),
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
  const t = text.replace(/\s+/g, " ").trim();
  const problem = guidanceProblem(t, p.kind === "add" ? "fact" : null);
  if (problem) {
    flow.error = problem;
    if (showing(flow)) renderNow();
    return;
  }
  flow.error = "";
  const label = d.options.find((o) => o.key === flow.choice)?.label ?? "";
  const fact = keptFact(S.facts, p, t, label);
  S.facts = withFact(S.facts, fact);
  S.newFacts.push(fact.id);
  S.version++;
  log("guidance_kept", { id: d.id, fact, edited: t !== p.text });
  glowEvent({ kind: "guidance_kept" });
  done(flow, `Kept. Every agent now gets: “${t}”`);
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
 * "Not now": set the decision aside with the person's reason. Allowed before an answer is final
 * (including at pushback). The decision stays unanswered and its guess stays sealed; the agent is told
 * what to gather (simulated). It comes back only when the person resumes it.
 */
export function setAside(flow: Flow, d: Decision): void {
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
export function resume(id: string): void {
  const punt = S.punts[id];
  if (!punt) return;
  (S.puntHistory[id] ??= []).push(punt);
  delete S.punts[id];
  // A decision the person set aside stays theirs: even if a re-route says it could now be settled,
  // resuming brings it back to them, never to "Decided for you".
  if (!S.reopened.includes(id)) S.reopened.push(id);
  S.flows[id] = newFlow(id);
  log("resume", { id, reason_kind: punt.kind, reason: punt.reason });
  startSession(id);
}

export function undo(id: string): void {
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
  setRuleDraft(null);
  S.rules = S.rules.map((r) => (r.id === id ? { ...r, text: t } : r));
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
  const todo = [...new Set([...S.pending, ...ids])].filter((id) => !S.answered[id]);
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
      try {
        const card = await api<Card>("/api/route", { id, rules: S.rules, facts: S.facts });
        if (S !== s0 || S.version !== version) return; // answered under older guidance; the newer pass re-checks it
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
