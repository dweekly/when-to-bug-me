// The card in front of the person ("Now"): the question, its options and the reason box, dictation,
// and the follow-up after an answer (pushback, "why?", proposed guidance, what was sent down). The
// work each button starts lives in actions.ts; this module only draws and wires it.

import { EXAMPLES } from "../shared/examples";
import { type GlowEvent, hasBasis, topGuess } from "../shared/lifecycle";
import type { Card, Decision, RouteKind } from "../shared/types";
import { PUNT_KINDS } from "../shared/punt";
import { askQuestion, choose, chooseOther, done, finalize, glowEvent, keepFact, next, propose, resume, sendQuestionToAgent, setAside, undoChoice, undoWindowMs } from "./actions";
import { GLYPH, ROUTE_LABEL, SOURCE_LABEL, routeOf } from "./derive";
import { go } from "./router";
import { tourAfterRender } from "./tour";
import { renderVisual } from "./visuals";
import { type Child, $, announce, h } from "./dom";
import { type Flow, F, Q, S, byId, isCard, log, newFlow, save, setF, unfinished } from "./state";
import { render } from "./views";

export function quoteLine(c: Card): Child {
  const q = c.rule_quoted || c.fact_quoted;
  return h("p", { class: "why" }, c.why_here, q && !c.why_here.includes(q) ? h("span", {}, " ", h("q", {}, q)) : null);
}

/**
 * Draw the decision in front of the person. Afterwards, dictation keeps running only if its
 * microphone is still on screen and lit: whichever path the draw took (a closed card, a card that
 * couldn't be evaluated, another decision), speech can never keep writing somewhere unseen.
 */
export function renderNow(): void {
  drawNow();
  stopVoiceIfMicGone();
}

function drawNow(): void {
  const root = document.getElementById("now");
  if (!root) return; // not in the focus view
  root.replaceChildren();
  const id = S.current;
  if (!id) return;
  // A re-route can settle the card in front of the person; then it is no longer theirs to decide.
  if (!S.answered[id] && !unfinished(id) && !S.punts[id] && routeOf(id) === "settle") {
    announce("A rule change means Bug Me now handles that one; it is under Decided for you.");
    if (F?.id === id) setF(null);
    go({ view: "settled" });
    return;
  }
  const d = byId.get(id)!;
  const c = S.cards[id];
  // Opened by link or Back: a decision already answered is shown, not reopened; a set-aside one
  // needs an explicit Resume before it can be answered.
  if (S.answered[id] && !S.flows[id]) return renderClosed(root, d, "answered");
  if (S.punts[id]) return renderClosed(root, d, "aside");
  if (!F || F.id !== id) setF((S.flows[id] ??= newFlow(id)));
  const flow = F!;
  stopVoiceUnlessFor(flow.id);
  if (!isCard(c)) {
    root.append(h("div", { class: "card" }, h("h3", { id: "now-q" }, d.question), h("p", { class: "adjusted" }, `Couldn't evaluate this one: ${c?.unavailable ?? "no route yet"}.`)));
    return;
  }
  const route = routeOf(id)!;
  const project = Q.persona.projects.find((p) => p.id === d.project)!;
  const locked = F!.phase !== "choose";

  const notes = new Map((c.option_notes ?? []).map((n) => [n.option, n]));
  const opts = h(
    "div",
    { class: "options", role: "group", "aria-label": "Options: choosing one decides" },
    ...d.options.map((o) => {
      const n = notes.get(o.key);
      return h(
        "button",
        {
          type: "button",
          class: "opt",
          "data-key": o.key,
          "aria-pressed": String(flow.choice === o.key),
          disabled: locked,
          onclick: () => choose(flow, d, route, o.key),
        },
        h("span", { class: "key", "aria-hidden": "true" }, o.key),
        h("b", { class: "opt-label" }, o.label),
        n && (n.pros.length || n.cons.length)
          ? h("ul", { class: "procon" }, ...n.pros.map((t) => h("li", { class: "pro" }, h("span", { class: "sr-only" }, "For: "), t)), ...n.cons.map((t) => h("li", { class: "con" }, h("span", { class: "sr-only" }, "Against: "), t)))
          : o.description
            ? h("span", { class: "opt-desc" }, o.description)
            : null,
        n?.consequence ? h("span", { class: "consequence" }, n.consequence) : null,
        o.key === d.recommended ? h("i", { class: "agent-pick" }, "the agent's pick") : null,
      );
    }),
  );

  const variants =
    d.explore?.kind === "variants"
      ? h(
          "div",
          { class: "variants" },
          ...Object.entries(d.explore.variants).map(([k, file]) =>
            h(
              "figure",
              { class: "variant", style: "margin:0" },
              h("h4", {}, h("span", {}, `${k}. ${d.options.find((o) => o.key === k)?.label ?? k}`), h("span", {}, "built on a preview branch")),
              h("iframe", { src: `/variants/${file}`, title: `Clickable prototype, option ${k}`, sandbox: "allow-scripts", loading: "lazy" }),
            ),
          ),
        )
      : null;

  // The Why panel: optional, to the side. In "Yes, but…" mode it holds the conditions instead.
  const conditionsMode = flow.mode === "conditions";
  const whyLabel = conditionsMode ? "Your conditions, then choose the option they go with" : d.explore ? "Why? (optional) In a sentence, what happens next?" : "Why? (optional)";
  const ta = h("textarea", { id: "basis", rows: 4, placeholder: conditionsMode ? "Yes, as long as…" : "Say it or type it. A reason becomes guidance every agent follows.", disabled: !["choose", "pending"].includes(flow.phase) }) as HTMLTextAreaElement;
  ta.value = flow.basis;
  ta.addEventListener("input", () => (flow.basis = ta.value));
  const mic = micButton(ta, !["choose", "pending"].includes(flow.phase), flow, (t) => (flow.basis = t));
  const whyPanel = h(
    "aside",
    { class: `why-panel${conditionsMode ? " conditions" : ""}` },
    h("label", { for: "basis" }, whyLabel),
    h("div", { class: "basis-row" }, ta, mic),
    flow.phase === "choose" ? exampleButton(d, ta) : null,
  );

  const chosenLabel = d.options.find((o) => o.key === flow.choice)?.label ?? "";
  const pendingBar =
    flow.phase === "pending"
      ? h(
          "div",
          { class: "undo-bar", role: "status" },
          h("span", {}, `Decided: ${chosenLabel}${conditionsMode && flow.basis.trim() ? ", with your conditions" : ""}`),
          h("button", { type: "button", class: "linkish undo", onclick: () => undoChoice(flow) }, "Undo"),
          h("span", { class: "drain", "aria-hidden": "true", style: `--undo-ms: ${undoWindowMs()}ms` }),
        )
      : null;

  const otherWays =
    flow.phase === "choose"
      ? h(
          "div",
          { class: "other-ways", role: "group", "aria-label": "Other ways to answer" },
          h("button", { type: "button", class: "way", "aria-pressed": String(conditionsMode), onclick: () => toggleMode(flow, "conditions") }, "Yes, but…"),
          h("button", { type: "button", class: "way", "aria-pressed": String(flow.mode === "other"), onclick: () => toggleMode(flow, "other") }, "Something else"),
          h("button", { type: "button", class: "way", "aria-pressed": String(flow.mode === "ask"), onclick: () => toggleMode(flow, "ask") }, "Ask a question"),
          h("button", { type: "button", class: "linkish not-now", onclick: () => startPunt(flow) }, "Not now"),
        )
      : flow.phase === "pushback"
        ? h("div", { class: "other-ways" }, h("button", { type: "button", class: "linkish not-now", onclick: () => startPunt(flow) }, "Not now"))
        : null;
  const modePanel = flow.phase === "choose" ? (flow.mode === "other" ? otherPanel(flow, d, route) : flow.mode === "ask" ? askPanel(flow, d) : null) : null;

  const lastPunt = !S.answered[id] ? S.puntHistory[id]?.[S.puntHistory[id].length - 1] : undefined;
  const why = c.adjusted
    ? h("p", { class: "why" }, h("span", { class: "why-mark", "aria-hidden": "true" }, "⌁"), "Code adjusted this route. ", c.adjusted)
    : quoteLine(c);

  const card = h(
    "article",
    { class: `card${arrived.has(id) ? " steady" : ""}`, "data-route": route, "aria-labelledby": "now-q" },
    h(
      "div",
      { class: "meta" },
      h("span", { class: "glyph", "aria-hidden": "true" }, GLYPH[route]),
      h("span", { class: "route-label" }, ROUTE_LABEL[route]),
      h("span", { class: "chain" }, d.agent.join(" › ")),
    ),
    // Brief first, then why it is the person's, then the question.
    h("p", { class: "briefing" }, c.briefing || c.in_your_terms),
    why,
    h("h3", { id: "now-q" }, c.headline || d.question),
    lastPunt
      ? h("p", { class: "resumed" }, `You set this aside: “${lastPunt.reason}”. The agent was asked to: ${lastPunt.instruction.replace(/^[^:]*: /, "")} Nothing new has been gathered in this prototype.`)
      : null,
    S.changes[id] ? h("p", { class: "change-note" }, S.changes[id]) : null,
    flow.message && ["choose", "pending"].includes(flow.phase) ? h("p", { class: "adjusted", role: "status" }, flow.message) : null,
    h(
      "div",
      { class: "decide-grid" },
      h("div", { class: "decide-main" }, opts, d.visual ? drawnOnce(id, renderVisual(d.visual, d, flow.choice)) : null, variants),
      flow.phase === "punting" ? null : whyPanel,
    ),
    pendingBar,
    flow.phase === "punting" ? puntPanel(flow, d) : otherWays,
    modePanel,
    h(
      "details",
      { class: "more" },
      h("summary", {}, "More context"),
      c.briefing && c.in_your_terms ? h("p", { class: "briefing-text" }, c.in_your_terms) : null,
      c.headline !== d.question ? h("p", { class: "original" }, h("span", { class: "quiet" }, "The agent asked: "), h("q", {}, d.question)) : null,
      h("p", { class: "context" }, h("span", { class: "quiet" }, "From the agent: "), d.context),
      c.adjusted ? h("p", { class: "quiet" }, "Claude's own reasoning: ", c.why_here) : null,
      h("p", { class: "quiet" }, `Routing, briefing and notes: ${SOURCE_LABEL[c.source]}.`),
    ),
    flow.phase === "punting" ? null : followup(d, route),
  );
  arrived.add(id);
  root.append(card);
  tourAfterRender();
}

/** Open or close one of the other ways to answer; only one is open at a time. */
function toggleMode(flow: Flow, mode: NonNullable<Flow["mode"]>): void {
  flow.mode = flow.mode === mode ? null : mode;
  flow.error = "";
  renderNow();
  const focus = { conditions: "basis", other: "other", ask: "question" }[mode];
  if (flow.mode) (document.getElementById(focus) as HTMLTextAreaElement | null)?.focus();
}

/** "Something else": write the option you want instead. */
function otherPanel(flow: Flow, d: Decision, route: RouteKind): HTMLElement {
  const ta = h("textarea", { id: "other", rows: 2, placeholder: "What should the agent do instead?" }) as HTMLTextAreaElement;
  ta.value = flow.other;
  ta.addEventListener("input", () => (flow.other = ta.value));
  return h(
    "div",
    { class: "mode-panel" },
    h("label", { for: "other" }, "Something else"),
    ta,
    flow.error ? h("p", { class: "adjusted", role: "alert" }, flow.error) : null,
    h("div", { class: "row" }, h("button", { type: "button", class: "primary", onclick: () => chooseOther(flow, d, route) }, "Send this instead")),
  );
}

/** "Ask a question": Claude answers from what the agent provided, or says what is missing. */
function askPanel(flow: Flow, d: Decision): HTMLElement {
  const ta = h("textarea", { id: "question", rows: 2, placeholder: "What would you need to know?" }) as HTMLTextAreaElement;
  ta.value = flow.question;
  ta.addEventListener("input", () => {
    flow.question = ta.value;
    // An answer belongs to the question that was asked; editing the question retires it.
    if (flow.askAnswer) {
      flow.askAnswer = null;
      document.querySelector("#now .ask-answer")?.remove();
    }
  });
  const a = flow.askAnswer;
  return h(
    "div",
    { class: "mode-panel" },
    h("label", { for: "question" }, "Ask a question"),
    ta,
    flow.error ? h("p", { class: "adjusted", role: "alert" }, flow.error) : null,
    h("div", { class: "row" }, h("button", { type: "button", class: "ghost", onclick: () => void askQuestion(flow, d) }, "Ask"), flow.message ? h("span", { class: "quiet" }, flow.message) : null),
    a
      ? h(
          "div",
          { class: `ask-answer${a.answerable ? "" : " missing"}`, role: "status" },
          h("p", {}, a.answer),
          h("p", { class: "quiet" }, a.answerable ? `${SOURCE_LABEL[a.source]}. Choose an option above when you're ready.` : SOURCE_LABEL[a.source]),
          a.answerable ? null : h("button", { type: "button", class: "ghost", onclick: () => sendQuestionToAgent(flow, d) }, "Ask the agent, and set this aside"),
        )
      : null,
  );
}

/** A read-only card for a decision that is answered, or set aside and waiting for Resume. */
function renderClosed(root: HTMLElement, d: Decision, why: "answered" | "aside"): void {
  const c = S.cards[d.id];
  const headline = (isCard(c) && c.headline) || d.question;
  const body: Child[] = [];
  if (why === "answered") {
    const a = S.answered[d.id];
    const chosen = d.options.find((o) => o.key === a.final);
    body.push(
      h("p", {}, h("span", { class: "quiet" }, a.other ? "You chose something else: " : "You decided: "), a.other ?? chosen?.label ?? a.final),
      a.conditions ? h("p", { class: "quiet" }, "With conditions: “", a.conditions, "”") : a.basis ? h("p", { class: "quiet" }, "“", a.basis, "”") : null,
    );
  } else {
    const p = S.punts[d.id];
    body.push(
      h("p", {}, h("span", { class: "quiet" }, "Set aside: "), "“", p.reason, "”"),
      h("p", { class: "senddown" }, `The agent was asked (simulated): ${p.instruction}`),
      h("div", { class: "actions" }, h("button", { type: "button", class: "primary", onclick: () => resume(d.id) }, "Resume")),
    );
  }
  root.append(h("article", { class: "card steady closed", "aria-labelledby": "now-q" }, h("h3", { id: "now-q" }, headline), ...body));
  tourAfterRender();
}

/** Cards already shown on this visit; only a card's first appearance animates in. */
const arrived = new Set<string>();

/** Decisions whose briefing has already drawn in on this visit; later renders skip the animation. */
const drawn = new Set<string>();
function drawnOnce(id: string, fig: HTMLElement): HTMLElement {
  if (drawn.has(id)) fig.classList.add("drawn");
  else drawn.add(id);
  return fig;
}

/** Open the "Not now" panel on this card, remembering where to return if the person cancels. */
function startPunt(flow: Flow): void {
  stopVoiceUnlessFor(""); // dictation was writing the answer; it must not carry on into the reason box
  flow.puntFrom = flow.phase === "pushback" ? "pushback" : "choose";
  flow.phase = "punting";
  flow.error = "";
  save();
  renderNow();
}

/**
 * "What would you need to decide this?" Four quick choices, each followed by its own pointed
 * question; a sentence is required, because it is what the agent will act on.
 */
function puntPanel(flow: Flow, d: Decision): HTMLElement {
  const spec = PUNT_KINDS.find((k) => k.kind === flow.puntKind);
  const ta = h("textarea", { id: "punt-reason", rows: 2, placeholder: spec ? spec.ask : "", disabled: !spec }) as HTMLTextAreaElement;
  ta.value = flow.puntReason;
  ta.addEventListener("input", () => (flow.puntReason = ta.value));
  return h(
    "div",
    { class: "punt", role: "group", "aria-labelledby": "punt-h" },
    h("p", { class: "lead", id: "punt-h" }, "What would you need to decide this?"),
    h(
      "div",
      { class: "chips" },
      ...PUNT_KINDS.map((k) =>
        h(
          "button",
          {
            type: "button",
            class: "chip-btn",
            "aria-pressed": String(flow.puntKind === k.kind),
            onclick: () => {
              flow.puntKind = k.kind;
              flow.error = "";
              renderNow();
              (document.getElementById("punt-reason") as HTMLTextAreaElement | null)?.focus();
            },
          },
          k.label,
        ),
      ),
    ),
    spec ? h("label", { for: "punt-reason" }, spec.ask) : null,
    h("div", { class: "basis-row" }, ta, spec ? micButton(ta, false, flow, (t) => (flow.puntReason = t)) : h("span", {})),
    flow.error ? h("p", { class: "adjusted", role: "alert" }, flow.error) : null,
    h(
      "div",
      { class: "actions" },
      h("button", { type: "button", class: "primary", onclick: () => setAside(flow, d) }, "Set aside"),
      h(
        "button",
        {
          type: "button",
          class: "linkish",
          onclick: () => {
            stopVoiceUnlessFor(""); // likewise, dictation into the reason must not carry on into the answer
            flow.phase = flow.puntFrom ?? "choose";
            flow.error = "";
            save();
            renderNow();
          },
        },
        "Cancel",
      ),
    ),
  );
}

/** The one recognition session that may be running, and the decision whose answer it is writing. */
let voice: { rec: SpeechRec; flowId: string } | null = null;

/** Stop dictation when the card it was writing into is no longer the one in front of the person. */
export function stopVoiceUnlessFor(flowId: string): void {
  if (voice && voice.flowId !== flowId) {
    voice.rec.stop();
    voice = null;
  }
}

/** Stop dictation when no lit microphone is on screen to show that it is listening. */
export function stopVoiceIfMicGone(): void {
  if (voice && !document.querySelector('.mic[aria-pressed="true"]')) {
    voice.rec.stop();
    voice = null;
  }
}

/**
 * A dictation button. Transcripts are written through `write` into the flow that owned the button
 * when dictation started, and mirrored into whichever textarea with the same id is on screen now
 * (re-renders replace the element), so speech can never land in another decision's answer.
 */
export function micButton(ta: HTMLTextAreaElement, disabled: boolean, flow: Flow, write: (text: string) => void): HTMLElement {
  const W = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
  const Ctor = W.SpeechRecognition ?? W.webkitSpeechRecognition;
  if (!Ctor) return h("span", { hidden: true });
  const listening = voice?.flowId === flow.id;
  const b = h("button", { type: "button", class: "mic", "aria-pressed": String(listening), "aria-label": "Answer by voice", title: "Answer by voice", disabled }, "🎙") as HTMLButtonElement;
  b.addEventListener("click", () => {
    if (voice) {
      voice.rec.stop();
      voice = null;
      b.setAttribute("aria-pressed", "false");
      return;
    }
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = true;
    const base = ta.value ? `${ta.value} ` : "";
    rec.onresult = (e: SpeechEvent) => {
      if (voice?.rec !== rec) return;
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      write(base + text);
      const onScreen = document.getElementById(ta.id) as HTMLTextAreaElement | null;
      if (onScreen && F === flow) {
        onScreen.value = base + text;
        onScreen.dispatchEvent(new Event("input"));
      }
    };
    rec.onend = () => {
      if (voice?.rec === rec) voice = null;
      b.setAttribute("aria-pressed", "false");
    };
    voice = { rec, flowId: flow.id };
    rec.start();
    b.setAttribute("aria-pressed", "true");
  });
  return b;
}
export interface SpeechRec {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: (e: SpeechEvent) => void;
  onend: () => void;
  start(): void;
  stop(): void;
}
export interface SpeechEvent {
  results: { length: number; [i: number]: { [j: number]: { transcript: string } } };
}

/**
 * A button that fills in the recorded example's reason, offered only when live calls are off and
 * the visitor picked the example's option. It is labeled; it never replaces the visitor's own words.
 */
export function exampleButton(d: Decision, ta: HTMLTextAreaElement): Child {
  // Offered before the click (clicking decides), for the option the recorded reason goes with.
  const ex = EXAMPLES.find((e) => e.id === d.id && (!F?.choice || e.choice === F.choice));
  if (!ex || Q.mode === "live") return null;
  return h(
    "p",
    { class: "example" },
    "Live calls are off, so only recorded answers can be evaluated. ",
    h(
      "button",
      {
        type: "button",
        class: "linkish",
        onclick: () => {
          ta.value = ex.reason;
          ta.dispatchEvent(new Event("input"));
          if (F) F.basis = ex.reason;
        },
      },
      `Use Jordan's recorded reason for “${d.options.find((o) => o.key === ex.choice)?.label ?? ex.choice}”`,
    ),
  );
}

export function followup(d: Decision, route: RouteKind): Child {
  if (!F || F.id !== d.id) return null;
  if (F.phase === "busy") return h("div", { class: "followup" }, h("p", {}, F.message || "One moment…"));
  if (F.phase === "pushback") {
    const chosen = d.options.find((o) => o.key === F!.choice)!;
    return h(
      "div",
      { class: "followup push", role: "alert" },
      h("p", { class: "lead" }, "Before this goes out: you told me something that points the other way."),
      h("p", {}, h("q", {}, F.pushback ?? "")),
      h("p", {}, `Still go with “${chosen.label}”?`),
      h(
        "div",
        { class: "actions" },
        h("button", { type: "button", class: "primary", onclick: () => void finalize(F!, d, route, F!.choice!, "kept") }, "Yes, this one is an exception"),
        ...d.options
          .filter((o) => o.key !== F!.choice)
          .map((o) => h("button", { type: "button", class: "ghost", onclick: () => void finalize(F!, d, route, o.key, "changed") }, `Change to “${o.label}”`)),
        h("button", { type: "button", class: "ghost", onclick: () => startPunt(F!) }, "Not now"),
      ),
    );
  }
  if (F.phase === "done" && F.choice === "other") {
    // "Something else": no guess was made among the options, so none is revealed.
    return h(
      "div",
      { class: "followup reveal", "aria-live": "polite" },
      h("p", { class: "senddown" }, `Sent down to ${d.agent[d.agent.length - 1]} (simulated): ${F.send_down}`),
      h("div", { class: "after-marks" }, h("button", { type: "button", class: "primary", onclick: () => next() }, "Next decision")),
    );
  }
  if (!F.guess) return F.message ? h("div", { class: "followup" }, h("p", {}, F.message)) : null;

  const top = topGuess(F.guess);
  const guessed = d.options.find((o) => o.key === top.option)!;
  const parts: Child[] =
    F.phase === "why"
      ? []
      : [h("p", {}, h("b", {}, "Bug Me's guess, hidden until now: "), `${guessed.label} (${Math.round(top.p * 100)}%).`, top.option === F.choice ? " You agreed." : " You went the other way.")];
  if (F.phase === "why") {
    const ta = h("textarea", { class: "fact-edit", id: "why", rows: 2, placeholder: "Say it or type it" }) as HTMLTextAreaElement;
    const flow = F;
    ta.value = flow.basis;
    ta.addEventListener("input", () => (flow.basis = ta.value));
    parts.push(
      h("p", { class: "lead" }, "I'm curious: why?"),
      h("p", {}, "Your answer surprised me. Your reason can become guidance for every agent."),
      h("label", { for: "why", class: "sr-only" }, "Why did you choose that?"),
      h("div", { class: "basis-row" }, ta, micButton(ta, false, flow, (t) => (flow.basis = t))),
      flow.error ? h("p", { class: "adjusted", role: "alert" }, flow.error) : null,
      exampleButton(d, ta),
      h(
        "div",
        { class: "actions" },
        h("button", { type: "button", class: "primary", onclick: () => { flow.basis = ta.value; void propose(flow, d); } }, "Tell Bug Me"),
        h("button", { type: "button", class: "linkish", onclick: () => done(flow, "Skipped the why.") }, "skip"),
      ),
    );
  }
  if (F.phase === "proposal" && F.proposal) {
    const p = F.proposal;
    if (p.kind === "none") {
      parts.push(h("p", {}, p.confirm || "Got it. Nothing to remember from that one."));
      parts.push(h("button", { type: "button", class: "primary", onclick: () => done(F!, "") }, "Next decision"));
    } else {
      const input = h("textarea", { class: "fact-edit", id: "fact-text", rows: 2, "aria-label": "Proposed guidance (you can edit it)" }) as HTMLTextAreaElement;
      const flow = F;
      input.value = flow.factDraft || p.text;
      input.addEventListener("input", () => (flow.factDraft = input.value));
      const replacing = p.kind === "replace" ? S.facts.find((f) => f.id === p.replaces) : undefined;
      parts.push(
        h("p", {}, p.confirm),
        h("p", {}, h("b", {}, replacing ? `Replace “${replacing.text}” with:` : "Remember this for every agent?")),
        input,
        flow.error ? h("p", { class: "adjusted", role: "alert" }, flow.error) : null,
        h("p", { class: "meta-line" }, `${SOURCE_LABEL[p.source]} · would re-check ${p.reroute.length} waiting decision${p.reroute.length === 1 ? "" : "s"}`),
        h(
          "div",
          { class: "actions" },
          h("button", { type: "button", class: "primary", onclick: () => void keepFact(flow, d, input.value, p) }, "Keep it"),
          h("button", { type: "button", class: "ghost", onclick: () => { log("guidance_discarded", { id: d.id, text: p.text }); done(flow, "Discarded."); } }, "Don't keep"),
        ),
      );
    }
  }
  if (F.phase === "done") {
    if (F.message) parts.push(h("p", {}, F.message));
    for (const rid of F.rerouted) {
      const rd = byId.get(rid)!;
      const rc = S.cards[rid];
      parts.push(
        h(
          "p",
          { class: "rerouted" },
          h("b", {}, "Re-routed: "),
          (isCard(rc) && rc.headline) || rd.question,
          " ",
          h("span", {}, S.changes[rid] ?? ""),
          " ",
          S.answered[rid] ? null : h("button", { type: "button", class: "linkish", onclick: () => go({ view: "focus", id: rid }) }, "Look at it"),
        ),
      );
    }
    parts.push(
      h("p", { class: "senddown" }, `Sent down to ${d.agent[d.agent.length - 1]} (simulated): ${F.send_down || "proceed with your choice."}`),
      h(
        "div",
        { class: "after-marks" },
        markButton(d.id, "shouldnt_have_come", "This shouldn't have come to me"),
        h("button", { type: "button", class: "primary", onclick: () => next() }, "Next decision"),
      ),
    );
  }
  return h("div", { class: "followup reveal", "aria-live": "polite" }, ...parts);
}

export function markButton(id: string, mark: string, label: string): HTMLElement {
  const marks = S.answered[id]?.marks ?? S.settledMarks[id] ?? [];
  const on = marks.includes(mark);
  return h(
    "button",
    {
      type: "button",
      "aria-pressed": String(on),
      onclick: () => {
        const list = S.answered[id] ? S.answered[id].marks : (S.settledMarks[id] ??= []);
        if (list.includes(mark)) list.splice(list.indexOf(mark), 1);
        else {
          list.push(mark);
          const ev: GlowEvent = mark === "shouldnt_have_come" ? { kind: "shouldnt_have_come" } : { kind: "correction_mark" };
          glowEvent(ev);
        }
        log("mark", { id, mark, on: list.includes(mark) });
        save();
        render();
      },
    },
    label,
  );
}
