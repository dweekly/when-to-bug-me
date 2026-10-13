// The card in front of the person ("Now"): the question, its options and the reason box, dictation,
// and the follow-up after an answer (pushback, "why?", proposed guidance, what was sent down). The
// work each button starts lives in actions.ts; this module only draws and wires it.

import { CONVERSATIONS, EXAMPLES, scriptWords } from "../shared/examples";
import { type JordanTurn, type Quote, jordanTurns, primaryLabel } from "../shared/converse";
import { type GlowEvent, hasBasis, topGuess } from "../shared/lifecycle";
import type { Card, Decision, Mark, RouteKind } from "../shared/types";
import { PUNT_KINDS } from "../shared/punt";
import { canHuh, confirmThread, done, finalize, glowEvent, isSending, keepFact, next, pick, propose, readyToConfirm, resume, scriptIndex, sendTurn, setAside, showing, thinkEdited, unanswered } from "./actions";
import { drawableMarks } from "../shared/parse";
import { MAX_REASON_CHARS } from "../shared/constants";
import { payloadLine } from "./visuals-layout";
import { GLYPH, ROUTE_LABEL, SOURCE_LABEL, routeOf } from "./derive";
import { go } from "./router";
import { tourAfterRender } from "./tour";
import { type VoiceTarget, setVoiceTarget, voiceTargetKey } from "./voice";
import { renderVisual } from "./visuals";
import { type Child, $, announce, h } from "./dom";
import { type Flow, type ShownBugTurn, F, Q, S, byId, isCard, log, newFlow, save, setF, unfinished } from "./state";
import { render } from "./views";
import { OWNER_PAGE } from "./livemode";

export function quoteLine(c: Card): Child {
  const q = c.rule_quoted || c.fact_quoted;
  return h("p", { class: "why" }, c.why_here, q && !c.why_here.includes(q) ? h("span", {}, " ", h("q", {}, q)) : null);
}

/**
 * Draw the decision in front of the person, then tell the voice firefly where speech goes now
 * (voice.ts). Whatever path the draw took (a closed card, a card that couldn't be evaluated, another
 * decision), speech can only ever go to a box on this card.
 */
export function renderNow(): void {
  drawNow();
  setVoiceTarget(voiceTargetFor());
}

/** The box on this card that speech fills: the Why box, the "why?" prompt, or the set-aside reason. */
function voiceTargetFor(): VoiceTarget | null {
  const flow = F;
  if (!flow || S.current !== flow.id) return null;
  // While Send is finishing, the words still go to the think box: the last phrase belongs to the answer.
  const box = flow.phase === "why" ? "why" : flow.phase === "punting" ? "punt-reason" : flow.phase === "choose" ? "think" : null;
  if (!box || !document.getElementById(box)) return null;
  return {
    // The turn number is part of the key, so late words can't land in the next turn.
    key: `${flow.id}:${box}:${flow.sent}`,
    el: () => document.getElementById(box) as HTMLTextAreaElement | null,
    write: (t) => {
      if (box === "punt-reason") flow.puntReason = t;
      else if (box === "think") thinkEdited(flow, t);
      else flow.basis = t;
    },
  };
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
  if (!isCard(c)) {
    root.append(h("div", { class: "card" }, h("h3", { id: "now-q" }, d.question), h("p", { class: "adjusted" }, `Couldn't evaluate this one: ${c?.unavailable ?? "no route yet"}.`)));
    return;
  }
  const route = routeOf(id)!;
  const project = Q.persona.projects.find((p) => p.id === d.project)!;
  const locked = F!.phase !== "choose";

  const notes = new Map((c.option_notes ?? []).map((n) => [n.option, n]));
  const payload = d.visual?.kind === "payload" ? d.visual : null;
  const payloadField = payload ? payload.lines.find((l) => l.includes(`"${payload.field}"`)) : undefined;
  // Each option's column holds everything about it: its prototype, then its card (label, its line of
  // the payload, pros and cons, consequence). On a phone that reads A's, then B's.
  const opts = h(
    "div",
    { class: "options", role: "group", "aria-label": "Options: click one to pick it, then Send" },
    ...d.options.map((o) => {
      const n = notes.get(o.key);
      const line = payload && payloadField ? payloadLine(payloadField, payload.field, payload.variants[o.key] ?? payload.field) : null;
      const proto = d.explore?.kind === "variants" ? d.explore.variants[o.key] : undefined;
      return h(
        "div",
        { class: "opt-col" },
        proto
          ? h(
              "figure",
              { class: "variant", style: "margin:0" },
              h("h4", {}, h("span", {}, `${o.key}. ${o.label}`), h("span", {}, "built on a preview branch")),
              h("iframe", { src: `/variants/${proto}`, title: `Clickable prototype, option ${o.key}`, sandbox: "allow-scripts", loading: "lazy" }),
            )
          : null,
        h(
          "button",
          {
            type: "button",
            class: "opt",
            "data-key": o.key,
            "aria-pressed": String(flow.choice === o.key),
            disabled: locked,
            onclick: () => pick(flow, o.key),
          },
          h("span", { class: "key", "aria-hidden": "true" }, o.key),
          h("b", { class: "opt-label" }, o.label),
          line ? h("code", { class: "snippet" }, `${line.before}${line.key}${line.after}`.replace(/,\s*$/, "")) : null,
          n && (n.pros.length || n.cons.length)
            ? h("ul", { class: "procon" }, ...n.pros.map((t) => h("li", { class: "pro" }, h("span", { class: "sr-only" }, "For: "), t)), ...n.cons.map((t) => h("li", { class: "con" }, h("span", { class: "sr-only" }, "Against: "), t)))
            : o.description
              ? h("span", { class: "opt-desc" }, o.description)
              : null,
          n?.consequence ? h("span", { class: "consequence" }, n.consequence) : null,
          o.key === d.recommended ? h("i", { class: "agent-pick" }, "the agent's pick") : null,
        ),
      );
    }),
  );
  // A figure that describes both options (a timeline, bars, a chart, clocks) comes before them.
  const shared = d.visual && !payload ? drawnOnce(id, renderVisual(d.visual, d, flow.choice)) : null;
  const reach = payload ? h("p", { class: "reach quiet" }, payload.reach) : null;

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
    // Brief first, then why it is the person's, then any more context, then the question; the
    // conversation starts below the options.
    h("p", { class: "briefing" }, c.briefing || c.in_your_terms),
    why,
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
    h("h3", { id: "now-q" }, c.headline || d.question),
    // Until Bug Me has said anything, "Huh?" is about the card itself (paintThread shows or hides it).
    flow.phase === "choose" ? huhButton(flow, d, route, "huh-q") : null,
    lastPunt
      ? h("p", { class: "resumed" }, `You set this aside: “${lastPunt.reason}”. The agent was asked to: ${lastPunt.instruction.replace(/^[^:]*: /, "")} Nothing new has been gathered in this prototype.`)
      : null,
    S.changes[id] ? h("p", { class: "change-note" }, S.changes[id]) : null,
    shared,
    opts,
    reach,
    flow.phase === "punting" ? puntPanel(flow, d) : threadArea(flow, d, route),
    flow.phase === "punting" ? null : followup(d, route),
  );
  arrived.add(id);
  // The think box is the same element across renders, so typing keeps its focus, caret and undo history.
  const focused = document.activeElement?.id === "think" ? (document.activeElement as HTMLTextAreaElement) : null;
  const sel = focused ? [focused.selectionStart, focused.selectionEnd] : null;
  root.append(card);
  if (focused && sel && document.getElementById("think") === focused) {
    focused.focus();
    focused.setSelectionRange(sel[0], sel[1]);
  }
  paintThread();
  tourAfterRender();
}

/** The conversation area, kept per decision so a re-render moves it rather than rebuilding it: the
 *  composer keeps its focus, caret and undo history while Bug Me replies. */
const threadNodes = new Map<string, { el: HTMLElement; route: RouteKind; flow: Flow }>();

function threadArea(flow: Flow, d: Decision, route: RouteKind): HTMLElement | null {
  if (flow.phase !== "choose" && !flow.turns.length) return null;
  const kept = threadNodes.get(flow.id);
  // Only this very flow's element: its handlers belong to it (a reset morning has a new flow).
  if (kept && kept.flow === flow && kept.route === route) return kept.el;
  const ta = h("textarea", {
    id: "think",
    rows: 2,
    maxlength: MAX_REASON_CHARS,
    // On explored options, the prompt asks for a teach-back: what happens next on the one you pick.
    placeholder: d.explore ? "Talk it through: in a sentence, what happens next on the one you pick?" : "Talk it through, or pick one.",
    "aria-label": "Your turn: which way you lean, why, any conditions, any questions",
  }) as HTMLTextAreaElement;
  ta.value = flow.think;
  ta.addEventListener("input", () => {
    thinkEdited(flow, ta.value);
    fit(ta);
  });
  // Enter sends (Shift+Enter for a new line), as in any chat.
  ta.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    primary(flow, d, route);
  });
  const script = CONVERSATIONS.find((c) => c.id === d.id);
  const el = h(
    "section",
    { class: "think thread", "aria-label": "Conversation with Bug Me" },
    h("ol", { class: "turns" }),
    h("div", { class: "think-field composer" }, ta),
    h("p", { class: "think-msg adjusted", role: "status" }),
    h(
      "div",
      { class: "think-actions" },
      h("button", { type: "button", class: "linkish skip-q", onclick: () => startPunt(flow) }, "Skip"),
      script && Q.mode !== "live"
        ? h(
            "p",
            { class: "example" },
            h(
              "button",
              {
                type: "button",
                class: "linkish",
                onclick: () => {
                  const t = scriptWords(script)[scriptIndex(flow)];
                  if (!t) return;
                  if (t.pick) pick(flow, t.pick);
                  ta.value = t.text;
                  thinkEdited(flow, t.text);
                  fit(ta);
                },
              },
              "Use Jordan's words",
            ),
            " (recorded)",
          )
        : null,
      h("button", { type: "button", class: "primary send", onclick: () => primary(flow, d, route) }, "Send"),
    ),
  );
  threadNodes.set(flow.id, { el, route, flow });
  return el;
}

/** "Huh?" (docs/STAGE-6E.md): one press asks Bug Me to say the last thing it showed more plainly. */
function huhButton(flow: Flow, d: Decision, route: RouteKind, cls: string): HTMLElement {
  return h(
    "button",
    {
      type: "button",
      class: `huh ${cls}`,
      title: "Say that more plainly",
      // The explanation lands below the options; bring it into view, since this press asked for it.
      onclick: () => void sendTurn(flow, d, route, true).then(() => showing(flow) && document.querySelector("#now .turns > li:last-child")?.scrollIntoView({ block: "nearest" })),
    },
    h("span", { "aria-hidden": "true" }, "🤔 "),
    "Huh?",
  );
}

/** The primary button (and Enter): confirm what Bug Me read back, or send this turn. */
function primary(flow: Flow, d: Decision, route: RouteKind): void {
  if (readyToConfirm(flow)) void confirmThread(flow, d, route);
  else void sendTurn(flow, d, route);
}

/** Grow the textarea with its words. */
function fit(ta: HTMLTextAreaElement): void {
  ta.style.height = "auto";
  ta.style.height = `${ta.scrollHeight}px`;
}

/** What Bug Me heard in one of Jordan's turns, as marks on its words (from the latest reading). */
function marksFor(flow: Flow, turn: number): { kind: string; quote: string }[] {
  const l = flow.ledger;
  if (!l) return [];
  const at = (q: Quote | null | undefined) => (q && q.turn === turn ? [q.quote] : []);
  return [
    ...[...at(l.choice_quote), ...at(l.course)].map((quote) => ({ kind: "choice", quote })),
    ...l.why.flatMap(at).map((quote) => ({ kind: "why", quote })),
    ...l.conditions.flatMap(at).map((quote) => ({ kind: "but", quote })),
    ...l.questions.flatMap((x) => at(x.quote)).map((quote) => ({ kind: "ask", quote })),
    ...l.feedback.flatMap((x) => at(x.quote)).map((quote) => ({ kind: "fb", quote })),
  ];
}

/** One of Jordan's turns: the words with what Bug Me heard marked, and any option clicked with them. */
function jordanTurn(d: Decision, flow: Flow, t: JordanTurn, n: number): HTMLElement {
  const parts: Child[] = [];
  let at = 0;
  for (const m of drawableMarks(t.text, marksFor(flow, n) as Mark[])) {
    parts.push(t.text.slice(at, m.start), h("mark", { class: `m-${m.kind}` }, t.text.slice(m.start, m.end)));
    at = m.end;
  }
  parts.push(t.text.slice(at));
  const picked = t.pick ? d.options.find((o) => o.key === t.pick) : undefined;
  if (t.huh) return h("li", { class: "turn mine huh-turn" }, h("span", { class: "sr-only" }, `${Q.persona.first_name}: `), h("span", { class: "huh-chip" }, h("span", { "aria-hidden": "true" }, "🤔 "), "Huh?"));
  return h(
    "li",
    { class: "turn mine" },
    h("span", { class: "sr-only" }, `${Q.persona.first_name}: `),
    picked ? h("span", { class: "picked-chip" }, `${picked.key} · ${picked.label}`) : null,
    t.text ? h("p", {}, ...parts) : null,
  );
}

const face = () => h("img", { class: "bug-face", src: "/firefly/clay/attentive.png", alt: "", width: 28, height: 28 });

function bugTurn(t: ShownBugTurn, huh: HTMLElement | null = null): HTMLElement {
  return h(
    "li",
    { class: `turn bug${t.next === "confirm" ? " readback" : t.next === "explain" ? " explain" : ""}` },
    face(),
    h("p", {}, h("span", { class: "sr-only" }, "Bug Me: "), t.text),
    t.source && t.source !== "live" ? h("span", { class: "turn-src", title: SOURCE_LABEL[t.source] }, t.source === "code" ? "stand-in" : t.source) : null,
    huh,
  );
}

/** A read-only list of a finished conversation's turns. */
export function threadList(d: Decision, flow: Pick<Flow, "turns" | "ledger">): HTMLElement {
  let n = 0;
  return h("ol", { class: "turns" }, ...flow.turns.map((t) => (t.who === "jordan" ? jordanTurn(d, flow as Flow, t, n++) : bugTurn(t))));
}

/**
 * Bring the conversation in front of the person up to date in place: the turns, the lit option, the
 * primary button (Send, or the decision itself once Bug Me has read it back), any message. The
 * composer is never replaced, so typing and voice carry on undisturbed.
 */
export function paintThread(): void {
  const flow = F;
  const area = document.querySelector<HTMLElement>("#now .thread");
  if (!flow || !area || S.current !== flow.id) return;
  const d = byId.get(flow.id)!;
  for (const b of document.querySelectorAll<HTMLButtonElement>("#now .opt")) b.setAttribute("aria-pressed", String(flow.choice === b.dataset.key));
  const choosing = flow.phase === "choose";
  const busy = isSending(flow);

  const list = area.querySelector(".turns")!;
  let n = 0;
  const route = threadNodes.get(flow.id)?.route ?? routeOf(flow.id) ?? "decide";
  const huh = canHuh(flow);
  const items = flow.turns.map((t, i) => (t.who === "jordan" ? jordanTurn(d, flow, t, n++) : bugTurn(t, huh && i === flow.turns.length - 1 ? huhButton(flow, d, route, "huh-turn-btn") : null)));
  const huhQ = document.querySelector<HTMLElement>("#now .huh-q");
  if (huhQ) huhQ.hidden = !huh || flow.turns.some((t) => t.who === "bugme");
  if (busy && flow.turns.at(-1)?.who === "jordan") items.push(h("li", { class: "turn bug typing", "aria-hidden": "true" }, face(), h("p", {}, h("span", { class: "dots" }, "…"))));
  const grew = items.length !== list.childElementCount;
  list.replaceChildren(...items);
  // Follow the newest turn only if the person was already near the bottom.
  if (grew && window.innerHeight + window.scrollY > document.body.scrollHeight - 320) list.lastElementChild?.scrollIntoView({ block: "nearest" });

  const composer = area.querySelector<HTMLElement>(".composer")!;
  const ta = composer.querySelector("textarea")!;
  composer.hidden = !choosing;
  ta.disabled = !choosing;
  if (ta.value !== flow.think) ta.value = flow.think;
  fit(ta);

  const btn = area.querySelector<HTMLButtonElement>(".send");
  if (btn) {
    btn.hidden = !choosing;
    const confirm = readyToConfirm(flow);
    btn.textContent = confirm ? primaryLabel(d, flow.ledger!) : unanswered(flow) ? "Send again" : "Send";
    btn.classList.toggle("decide", confirm);
    btn.disabled = busy || (!confirm && !unanswered(flow) && !flow.think.trim() && !flow.pick);
  }
  const msg = area.querySelector(".think-msg")!;
  msg.textContent = flow.error || (choosing ? flow.message : "");
  const ex = area.querySelector<HTMLElement>(".example");
  const script = CONVERSATIONS.find((c) => c.id === d.id);
  if (ex) ex.hidden = !choosing || !script || !scriptWords(script)[scriptIndex(flow)];
  const skip = area.querySelector<HTMLButtonElement>(".skip-q");
  if (skip) {
    skip.hidden = !choosing;
    // While a turn is out, setting the card aside would leave it armed behind the panel.
    skip.disabled = busy;
  }

  // A figure that colours the picked option follows the pick.
  const fig = document.querySelector<HTMLElement>("#now .viz");
  if (fig && d.visual && d.visual.kind !== "payload" && (fig.dataset.selected ?? null) !== (flow.choice && flow.choice !== "other" ? flow.choice : null)) {
    const next = renderVisual(d.visual, d, flow.choice && flow.choice !== "other" ? flow.choice : null);
    next.classList.add("drawn");
    fig.replaceWith(next);
  }
  // A turn of Jordan's sent is a new voice target (its key carries Jordan's turn count), so a late
  // phrase from that turn can't land in the next; Bug Me's reply doesn't interrupt a correction being spoken.
  if (voiceTargetKey() && !voiceTargetKey().endsWith(`:${flow.sent}`)) setVoiceTarget(voiceTargetFor());
}

/** A read-only card for a decision that is answered, or set aside and waiting for Resume. */
function renderClosed(root: HTMLElement, d: Decision, why: "answered" | "aside"): void {
  const c = S.cards[d.id];
  const headline = (isCard(c) && c.headline) || d.question;
  const body: Child[] = [];
  if (why === "answered") {
    const a = S.answered[d.id];
    const chosen = d.options.find((o) => o.key === a.final);
    const lead = a.outcome === "rejected" ? "You rejected the question: " : a.other ? "You chose something else: " : "You decided: ";
    body.push(
      // The conversation as it happened, read-only, then the outcome.
      a.thread ? threadList(d, a.thread) : null,
      h("p", {}, h("span", { class: "quiet" }, lead), a.other ?? chosen?.label ?? a.final),
      a.thread
        ? // A reason given after the conversation (at "I'm curious: why?") isn't in the thread: show it.
          a.basis && !jordanTurns(a.thread.turns).some((t) => t.text.includes(a.basis))
          ? h("p", { class: "quiet" }, "Your reason, given after: “", a.basis, "”")
          : null
        : a.conditions
          ? h("p", { class: "quiet" }, "With conditions: “", a.conditions, "”")
          : a.basis
            ? h("p", { class: "quiet" }, "“", a.basis, "”")
            : null,
    );
  } else {
    const p = S.punts[d.id];
    body.push(
      h("p", {}, h("span", { class: "quiet" }, "Set aside: "), "“", p.reason, "”"),
      h("p", { class: "senddown" }, OWNER_PAGE ? `Saved for the asking session: ${p.instruction}` : `The agent was asked (simulated): ${p.instruction}`),
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

/** Open the "Skip" panel on this card, remembering where to return if the person cancels. */
export function startPunt(flow: Flow): void {
  if (isSending(flow)) return; // a Send in progress is finished first
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
    h("div", { class: "basis-row" }, ta),
    flow.error ? h("p", { class: "adjusted", role: "alert" }, flow.error) : null,
    h(
      "div",
      { class: "actions" },
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
      h("button", { type: "button", class: "primary", onclick: () => void setAside(flow, d) }, "Set aside"),
    ),
  );
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
        h("button", { type: "button", class: "linkish skip-q", onclick: () => startPunt(F!) }, "Skip"),
        ...d.options
          .filter((o) => o.key !== F!.choice)
          .map((o) => h("button", { type: "button", class: "ghost", onclick: () => void finalize(F!, d, route, o.key, "changed") }, `Change to “${o.label}”`)),
        h("button", { type: "button", class: "primary", onclick: () => void finalize(F!, d, route, F!.choice!, "kept") }, "Yes, this one is an exception"),
      ),
    );
  }
  const outside = F.choice === "other" || F.choice === "rejected";
  // A course of the person's own, or a rejected question, has no guess to reveal; the rest (guidance,
  // re-routes, what was sent down) shows as for any answer.
  if (!F.guess && !(outside && (F.phase === "proposal" || F.phase === "done"))) return F.message ? h("div", { class: "followup" }, h("p", {}, F.message)) : null;

  const top = F.guess ? topGuess(F.guess) : null;
  const guessed = top ? d.options.find((o) => o.key === top.option)! : null;
  const parts: Child[] =
    F.phase === "why" || !top || !guessed
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
      h("div", { class: "basis-row" }, ta),
      flow.error ? h("p", { class: "adjusted", role: "alert" }, flow.error) : null,
      exampleButton(d, ta),
      h(
        "div",
        { class: "actions" },
        h("button", { type: "button", class: "linkish", onclick: () => done(flow, "Skipped the why.") }, "Skip"),
        h("button", { type: "button", class: "primary", onclick: () => { flow.basis = ta.value; void propose(flow, d); } }, "Tell Bug Me"),
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
          h("button", { type: "button", class: "ghost", onclick: () => { log("guidance_discarded", { id: d.id, text: p.text }); done(flow, "Discarded."); } }, "Don't keep"),
          h("button", { type: "button", class: "primary", onclick: () => void keepFact(flow, d, input.value, p) }, "Keep it"),
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
      h("p", { class: "senddown" }, OWNER_PAGE ? `Saved for the asking session: ${F.send_down || "proceed with your choice."}` : `Sent down to ${d.agent[d.agent.length - 1]} (simulated): ${F.send_down || "proceed with your choice."}`),
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
