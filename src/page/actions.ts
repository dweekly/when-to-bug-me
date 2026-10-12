// What the person's clicks do: answering (check for pushback, then record the final answer and the
// sealed guess), asking why, proposing and keeping guidance, editing rules, undoing a settled call,
// and re-routing waiting decisions under the new guidance. Each step updates state, saves, and
// redraws through views.ts / card.ts.

import { nextInSession } from "../shared/agenda";
import { MAX_FACTS, MAX_REASON_CHARS, MAX_RULE_CHARS, MAX_RULES, PARSE_SEND_WAIT_MS, PARSE_TYPING_IDLE_MS, REROUTE_CONCURRENCY } from "../shared/constants";
import { type SendPlan, answerParts, guidanceText, presentMarks, sendPlan } from "../shared/parse";
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
import type { AskOutput, Card, Decision, FactOutput, Mark, ParseOutput, RouteKind, Source } from "../shared/types";
import { api } from "./api";
import { drainVoice } from "./voice";
import { paintThink, renderNow } from "./card";
import { ROUTE_LABEL, agenda, routeOf, waitingIds } from "./derive";
import { announce } from "./dom";
import { go } from "./router";
import { type Asked, type Flow, type Parsed, type State, F, Q, S, byId, log, newFlow, save, setF } from "./state";

/** The person's words for each answer in progress, kept beside the flow for the answer path. */
const narrations = new WeakMap<Flow, Narration>();
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
 * The answer machinery for thinking out loud. The words live in the flow (`think`), with a revision
 * that every edit bumps. A parse is asked for one exact revision and applied only if the words are
 * still that revision; questions in the words are asked once each; Send claims the answer at once and
 * then waits for the parse of the final words. Updates in this section repaint the card in place
 * (card.ts paintThink), so typing never loses focus; lifecycle steps re-render as before.
 */

/** The parse in flight for each flow: which revision it is for, and its result once it lands. */
const parsing = new Map<string, { rev: number; done: Promise<Parsed | null> }>();
/** The typing pause timer for each flow. */
const idle = new Map<string, ReturnType<typeof setTimeout>>();
/** Flows whose Send has been claimed and not yet finished (a second click does nothing). */
const sending = new WeakSet<Flow>();

export function isSending(flow: Flow): boolean {
  return sending.has(flow);
}

/** The words changed. A finished voice phrase is read at once; typing, after a pause. */
export function thinkEdited(flow: Flow, d: Decision, text: string, by: "voice" | "typing"): void {
  if (text === flow.think) return;
  flow.think = text;
  flow.rev++;
  flow.error = "";
  clearTimeout(idle.get(flow.id));
  save();
  if (by === "voice") void readWords(flow, d);
  else idle.set(flow.id, setTimeout(() => void readWords(flow, d), PARSE_TYPING_IDLE_MS));
  repaint(flow);
}

/** Ask for a parse of the words as they are now (or reuse the one already out for this revision). */
function readWords(flow: Flow, d: Decision): Promise<Parsed | null> {
  const rev = flow.rev;
  const text = flow.think.trim();
  const out = parsing.get(flow.id);
  if (out && out.rev === rev) return out.done;
  if (flow.parsed?.rev === rev) return Promise.resolve(flow.parsed);
  if (!text) {
    applyParse(flow, d, { rev, choice: "none", marks: [], source: "code" });
    return Promise.resolve(flow.parsed);
  }
  if (text.length > MAX_REASON_CHARS) {
    flow.error = `That's more than ${MAX_REASON_CHARS} characters; the gist is enough.`;
    repaint(flow);
    return Promise.resolve(null);
  }
  const s0 = S;
  const done = api<ParseOutput & { source: Source }>("/api/parse", { id: d.id, text })
    .then((r) => {
      const p: Parsed = { rev, choice: r.choice, marks: r.marks, source: r.source };
      if (alive(s0, flow) && flow.rev === rev) applyParse(flow, d, p);
      return p;
    })
    .catch(() => null)
    .finally(() => {
      if (parsing.get(flow.id)?.rev === rev) parsing.delete(flow.id);
    });
  parsing.set(flow.id, { rev, done });
  return done;
}

/**
 * A parse of the current words: its marks are shown, and its choice picks unless a click came after
 * the last stated choice. A newly stated choice overrides a click; a deleted one clears a pick that
 * came from the words, never a click. New questions are asked.
 */
function applyParse(flow: Flow, d: Decision, p: Parsed): void {
  const before = flow.parsed?.choice ?? "none";
  flow.parsed = p;
  if (p.choice !== before) {
    if (p.choice !== "none") {
      flow.choice = p.choice;
      flow.choiceBy = "words";
    } else if (flow.choiceBy === "words") {
      flow.choice = null;
      flow.choiceBy = null;
    }
  }
  for (const m of p.marks) if (m.kind === "ask" && !flow.asks[m.quote]) void askOne(flow, d, m.quote);
  save();
  repaint(flow);
}

/** Click an option: it lights and is the pick. Nothing is sent until Send. */
export function pick(flow: Flow, key: string): void {
  if (flow.phase !== "choose" || sending.has(flow)) return;
  flow.choice = key;
  flow.choiceBy = "click";
  flow.message = "";
  save();
  repaint(flow);
}

/** Ask one question from the words of what the agent provided. Asked once per exact quote. */
async function askOne(flow: Flow, d: Decision, question: string): Promise<void> {
  const s0 = S;
  flow.asks[question] = { status: "pending", answer: "", source: null };
  repaint(flow);
  let next: Asked;
  try {
    const r = await api<AskOutput & { source: Source }>("/api/ask", { id: d.id, question: question.slice(0, MAX_REASON_CHARS) });
    next = { status: r.answerable ? "answered" : "missing", answer: r.answer, source: r.source };
    log("question", { id: d.id, question, answerable: r.answerable, answer: r.answer, source: r.source });
  } catch (e) {
    next = { status: "failed", answer: `Couldn't reach Claude for that (${(e as Error).message}).`, source: null };
  }
  if (!alive(s0, flow) || !flow.asks[question]) return;
  flow.asks[question] = next;
  save();
  repaint(flow);
}

/** The marks of the latest parse that still occur in the words. */
export function currentMarks(flow: Flow): Mark[] {
  return flow.parsed ? presentMarks(flow.think, flow.parsed.marks) : [];
}

/** Questions still in the words whose answer came back missing from what the agent provided. */
export function unansweredQuestions(flow: Flow): string[] {
  return currentMarks(flow).filter((m) => m.kind === "ask" && flow.asks[m.quote]?.status === "missing").map((m) => m.quote);
}

export function planFor(flow: Flow, d: Decision): SendPlan {
  return sendPlan(d, flow.choice, currentMarks(flow), unansweredQuestions(flow));
}

function repaint(flow: Flow): void {
  if (showing(flow)) paintThink();
}

/** Resolves to null after `ms`, so Send never waits on a parse forever. */
const timeout = (ms: number) => new Promise<null>((r) => setTimeout(() => r(null), ms));

/**
 * Send. Claimed at once (a second click does nothing). The microphone keeps writing here while the
 * last phrase finishes; then the words are snapshotted and read (at most PARSE_SEND_WAIT_MS), and
 * after every wait the flow, the card on screen and the routed card must be unchanged.
 */
export async function send(flow: Flow, d: Decision, route: RouteKind): Promise<void> {
  if (flow.phase !== "choose" || sending.has(flow)) return;
  sending.add(flow);
  const s0 = S;
  const card = S.cards[d.id];
  const still = () => alive(s0, flow) && showing(flow) && flow.phase === "choose" && S.cards[d.id] === card;
  flow.message = "";
  repaint(flow);
  try {
    await drainVoice();
    if (!still()) return;
    clearTimeout(idle.get(flow.id));
    const text = flow.think.trim();
    const rev = flow.rev;
    let parsed: Parsed | null = flow.parsed?.rev === rev ? flow.parsed : null;
    if (text && !parsed) {
      flow.message = "Reading what you said…";
      repaint(flow);
      parsed = await Promise.race([readWords(flow, d), timeout(PARSE_SEND_WAIT_MS)]);
      if (!still()) return;
      flow.message = "";
      if (flow.rev !== rev) {
        flow.message = "You added something while that was being read. Send again when you're done.";
        return;
      }
    }
    if (text.length > MAX_REASON_CHARS) {
      flow.error = `That's more than ${MAX_REASON_CHARS} characters; the gist is enough.`;
      return;
    }
    const marks = parsed ? presentMarks(text, parsed.marks) : [];
    const parts = answerParts(marks);
    const plan = parsed ? planFor(flow, d) : flow.choiceBy === "click" && flow.choice ? planFor({ ...flow, parsed: null }, d) : null;
    if (!plan || plan.kind === "nothing") {
      flow.message = parsed ? "Pick an option, or say which way you'd go." : "Couldn't read what you said just now. Pick an option, or try Send again.";
      return;
    }
    flow.basis = parsed ? parts.reason : text;
    flow.conditions = parsed ? parts.conditions : "";
    const narration = { narration: text, narrationMarks: marks, unparsed: !parsed && Boolean(text) };
    if (plan.kind === "ask-agent") return sendQuestionToAgent(flow, d, plan.questions);
    if (plan.kind === "other") return chooseOther(flow, d, route, parts.course, narration);
    flow.choice = plan.key;
    flow.card = card as Card;
    await answer(flow, d, route, narration);
  } finally {
    sending.delete(flow);
    if (showing(flow) && flow.phase === "choose") paintThink();
  }
}

/** The person's words as kept with the answer. `unparsed`: they couldn't be read, so they go down whole. */
export interface Narration {
  narration: string;
  narrationMarks: Mark[];
  unparsed: boolean;
}

/**
 * "Something else": the person described a course that is neither option. It is recorded as the
 * answer and is what the agent is told (simulated), in their words. Bug Me's sealed guess stays
 * sealed: it only ever guessed among the listed options.
 */
export function chooseOther(flow: Flow, d: Decision, route: RouteKind, course: string, n: Narration): void {
  const basis = flow.basis.trim();
  const conditions = flow.conditions.trim();
  const send_down = `${Q.persona.first_name} chose neither option. Instead: ${course}${conditions ? ` Conditions: ${conditions}` : ""}`;
  S.answered[d.id] = { initial: "other", final: "other", other: course, basis, guess: [], route, pushback: null, send_down, marks: [], narration: n.narration, narrationMarks: n.narrationMarks, ...(conditions ? { conditions } : {}) };
  log("answer", { id: d.id, route, initial: "other", final: "other", other: course, basis, conditions: conditions || undefined, narration: n.narration, guess_before_answer: null, source: isCardLike(S.cards[d.id]) ? (S.cards[d.id] as Card).source : null });
  glowEvent({ kind: "answered", route, basis: substantiveBasis(basis || course), againstRecommendation: true });
  flow.choice = "other";
  flow.send_down = send_down;
  done(flow, "");
}

const isCardLike = (c: unknown): boolean => Boolean(c) && typeof c === "object" && "source" in (c as object);

/** Questions the agent's material didn't answer go back to the asking agent, and the decision waits. */
export function sendQuestionToAgent(flow: Flow, d: Decision, questions: string[]): void {
  const question = questions.join(" ").replace(/\s+/g, " ").trim();
  const punt: Punt = { id: d.id, kind: "info", reason: question, at: new Date().toISOString(), instruction: puntInstruction("info", question, Q.persona.first_name) };
  S.punts[d.id] = punt;
  log("punt", { id: d.id, reason_kind: punt.kind, reason: punt.reason, instruction: punt.instruction, from_phase: "ask" });
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
  narrations.set(flow, n);
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
  // The person's "but…" phrases travel with the answer to the agent, verbatim. Words that couldn't be
  // read go down whole, labeled as such, so nothing they said is lost.
  const conditions = flow.conditions.trim();
  const n = narrations.get(flow) ?? (flow.think.trim() ? { narration: flow.think.trim(), narrationMarks: currentMarks(flow), unparsed: false } : undefined);
  const send_down = [
    r.send_down,
    conditions ? `Conditions from ${Q.persona.first_name}: ${conditions}` : "",
    n?.unparsed ? `${Q.persona.first_name}'s words, as said: “${n.narration}”` : "",
  ].filter(Boolean).join(" ");
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
  if (shouldAskWhy(choice, r.guess, guidanceText({ reason: basis, conditions }))) {
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
  const phase0 = flow.phase;
  await drainVoice(); // the last words of a spoken reason belong to it
  // Skipped, or already sent by an earlier click, while the phrase finished: nothing more to do.
  if (!alive(s0, flow) || flow.phase !== phase0) return;
  const basis = flow.basis.trim();
  // Guidance is proposed from the reason and the conditions, both in the person's words.
  const evidence = guidanceText({ reason: basis, conditions: flow.conditions.trim() });
  if (!hasBasis(evidence)) {
    done(flow, "");
    return;
  }
  if (evidence.length > MAX_REASON_CHARS) {
    flow.phase = flow.phase === "busy" ? "why" : flow.phase;
    flow.error = `Please keep it under ${MAX_REASON_CHARS} characters (it's ${evidence.length}); the gist is enough.`;
    if (showing(flow)) renderNow();
    return;
  }
  flow.error = "";
  if (basis) recordLateReason(d, basis);
  flow.phase = "busy";
  flow.message = "Turning that into guidance…";
  save();
  if (showing(flow)) render();
  try {
    const p = await api<FactOutput & { reroute: string[]; source: Source }>("/api/fact", {
      id: d.id,
      choice: flow.choice,
      reason: evidence,
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
export async function setAside(flow: Flow, d: Decision): Promise<void> {
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
