// The card in front of the person ("Now"): the question, its options and the reason box, dictation,
// and the follow-up after an answer (pushback, "why?", proposed guidance, what was sent down). The
// work each button starts lives in actions.ts; this module only draws and wires it.

import { EXAMPLES } from "../shared/examples";
import { type GlowEvent, hasBasis, topGuess } from "../shared/lifecycle";
import type { Card, Decision, RouteKind } from "../shared/types";
import { PUNT_KINDS } from "../shared/punt";
import { answer, done, finalize, glowEvent, keepFact, next, propose, setAside } from "./actions";
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

export function renderNow(): void {
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

  const opts = h(
    "div",
    { class: "options", role: "group", "aria-label": "Options" },
    ...d.options.map((o) =>
      h(
        "button",
        {
          type: "button",
          class: "opt",
          "aria-pressed": String(flow.choice === o.key),
          disabled: locked,
          onclick: () => {
            flow.choice = o.key;
            renderNow();
          },
        },
        h("b", {}, `${o.key}. ${o.label}`),
        o.description ? h("span", {}, o.description) : null,
        o.key === d.recommended ? h("i", { class: "agent-pick" }, "the agent's pick") : null,
      ),
    ),
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

  const chosen = d.options.find((o) => o.key === flow.choice);
  const basisLabel =
    d.explore && chosen
      ? `In a sentence: what happens next if you choose ${chosen.label}?`
      : route === "decide"
        ? "Why? Say it or type it."
        : "Why? (optional for a quick check)";
  const ta = h("textarea", { id: "basis", rows: 2, placeholder: "Talk it through. Your reason becomes guidance every agent follows.", disabled: locked }) as HTMLTextAreaElement;
  ta.value = flow.basis;
  ta.addEventListener("input", () => {
    flow.basis = ta.value;
    submit.toggleAttribute("disabled", !canSubmit());
  });
  const mic = micButton(ta, locked, flow, (t) => (flow.basis = t));
  // Substantive decisions and explored options (the teach-back) ask for a basis up front.
  const asksBasis = route === "decide" || Boolean(d.explore);
  // A substantive decision asks for its basis up front. A quick check-in is answered in one click;
  // if the answer surprises Bug Me, it asks "I'm curious: why?" before revealing its guess.
  const basis =
    asksBasis
      ? h("div", { class: "basis" }, h("label", { for: "basis" }, basisLabel), h("div", { class: "basis-row" }, ta, mic), locked ? null : exampleButton(d, ta))
      : null;

  const canSubmit = () => Boolean(flow.choice) && (!asksBasis || hasBasis(flow.basis) || skipBasis);
  let skipBasis = false;
  const submit = h("button", { type: "button", class: "primary", disabled: !canSubmit() || locked, onclick: () => void answer(d, route) }, "Decide") as HTMLButtonElement;
  const skip =
    asksBasis && !locked
      ? h(
          "button",
          {
            type: "button",
            class: "linkish",
            onclick: () => {
              skipBasis = true;
              submit.disabled = !canSubmit();
              announce("You can decide without a reason. It won't teach the fleet anything.");
            },
          },
          "decide without a reason",
        )
      : null;

  const notNow =
    !locked || flow.phase === "pushback"
      ? h("button", { type: "button", class: "ghost", onclick: () => startPunt(flow) }, "Not now")
      : null;
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
    h("h3", { id: "now-q" }, c.headline || d.question),
    lastPunt
      ? h("p", { class: "resumed" }, `You set this aside: “${lastPunt.reason}”. The agent was asked to: ${lastPunt.instruction.replace(/^[^:]*: /, "")} Nothing new has been gathered in this prototype.`)
      : null,
    d.visual ? drawnOnce(id, renderVisual(d.visual, d, flow.choice)) : null,
    variants,
    opts,
    why,
    S.changes[id] ? h("p", { class: "change-note" }, S.changes[id]) : null,
    h(
      "details",
      { class: "more" },
      h("summary", {}, "More context"),
      c.in_your_terms ? h("p", { class: "briefing-text" }, c.in_your_terms) : null,
      c.headline !== d.question ? h("p", { class: "original" }, h("span", { class: "quiet" }, "The agent asked: "), h("q", {}, d.question)) : null,
      h("p", { class: "context" }, d.context),
      c.adjusted ? h("p", { class: "quiet" }, "Claude's own reasoning: ", c.why_here) : null,
      h("p", { class: "quiet" }, `Routing: ${SOURCE_LABEL[c.source]}.`),
    ),
    flow.phase === "punting" ? null : basis,
    flow.phase === "punting" ? puntPanel(flow, d) : locked ? null : h("div", { class: "actions" }, submit, skip, notNow),
    flow.phase === "punting" ? null : followup(d, route),
  );
  arrived.add(id);
  root.append(card);
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
  const ex = EXAMPLES.find((e) => e.id === d.id && e.choice === F?.choice);
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
      "Use the recorded example reason",
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
