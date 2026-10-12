// Every screen except the decision card itself. One view at a time, chosen by the URL (router.ts):
// home (the overview: nothing to decide here), focus (one decision; card.ts draws it), between (a
// change of project), and the secondary views for what Bug Me decided, the rules, and the record.
// render() redraws the bar and the current view from state.

import { estimateMinutes, nextInSession } from "../shared/agenda";
import type { Mood } from "../shared/lifecycle";
import type { Card, RouteKind } from "../shared/types";
import { cancelPendingUnlessOn, editRule, resume, startSession, undo } from "./actions";
import { markButton, renderNow } from "./card";
import { type Mood as Mood6, setGlowMood, setVoiceTarget } from "./voice";
import { GLYPH, ROUTE_LABEL, SOURCE_LABEL, agenda, routeOf } from "./derive";
import { $, h } from "./dom";
import { type Route, go, hrefFor, parseRoute } from "./router";
import { F, Q, S, byId, isCard, setF, unfinished } from "./state";
import { openToursMenu, tourAfterRender } from "./tour";

/** A rule being edited, kept across re-renders so an async update never wipes the draft. */
let ruleDraft: { id: string; text: string; error: string; focus: boolean } | null = null;


/** Glow level at which the firefly is delighted rather than pleased. Heuristic, near the top of 0..1. */
const DELIGHTED_AT = 0.85;

/** The firefly's six moods (clay loops in public/firefly/clay/), picked from the glow state. */
export function moodAsset(mood: Mood, glow: number, waiting: number): string {
  if (waiting === 0) return "resting";
  if (mood === "sheepish") return "sheepish";
  if (mood === "dim") return "disappointed";
  if (glow >= DELIGHTED_AT) return "delighted";
  if (mood === "glowing") return "pleased";
  return "attentive";
}

function currentRoute(): Route {
  return parseRoute(location.hash, new Set(byId.keys()));
}

function waitingCount(): number {
  return agenda().sections.reduce((n, s) => n + s.decisions.length + s.check_ins.length, 0);
}

function link(r: Route, ...children: (Node | string)[]): HTMLElement {
  return h("a", { href: hrefFor(r) }, ...children);
}

function headline(id: string): string {
  const c = S.cards[id];
  return (isCard(c) && c.headline) || byId.get(id)!.question;
}

// ---------- The bar ----------

function renderBar(route: Route): void {
  const waiting = waitingCount();
  const asset = moodAsset(S.mood, S.glow, waiting);
  const reasons = S.record.filter((r) => (r.kind === "answer" && r.basis) || r.kind === "reason" || r.kind === "punt").length;
  const status: Record<string, string> = {
    resting: "Nothing is waiting on you.",
    attentive: reasons ? `${reasons} reason${reasons === 1 ? "" : "s"} given so far.` : "Glows brighter with every real reason you give.",
    pleased: `Glowing: ${reasons} real reason${reasons === 1 ? "" : "s"} this morning.`,
    delighted: `Bright: ${reasons} real reasons this morning.`,
    disappointed: "A little dimmer: that went through without a reason.",
    sheepish: "Sheepish: Bug Me brought you something it should have handled.",
  };
  const settledCount = agenda().settled.filter((id) => !S.reopened.includes(id)).length;
  const nav = (r: Route, label: string) =>
    h("a", { href: hrefFor(r), class: "nav", "aria-current": route.view === r.view ? "page" : null }, label);
  // The one firefly is the clay one in the corner (voice.ts): off, it shows the morning's glow.
  setGlowMood(asset as Mood6, status[asset]);
  $("bar").replaceChildren(
    h(
      "a",
      { href: "#/", class: "brand" },
      h("span", { class: "wordmark" }, "Bug Me"),
    ),
    h(
      "nav",
      { "aria-label": "Views" },
      nav({ view: "home" }, "Home"),
      nav({ view: "settled" }, `Decided for you${settledCount ? ` · ${settledCount}` : ""}`),
      nav({ view: "rules" }, "Rules"),
      nav({ view: "record" }, "Record"),
      h("button", { type: "button", class: "nav tours-btn", onclick: () => openToursMenu() }, "Tours"),
    ),
    h("a", { href: "/#real", class: "synthetic", title: "Everything here is made up. See what is real." }, { live: "Synthetic · live Claude", recorded: "Synthetic · recorded Claude", fake: "Synthetic · code stand-in" }[Q.mode]),
  );
}

// ---------- Home ----------

function renderHome(view: HTMLElement): void {
  const a = agenda();
  const remaining = a.sections.reduce((m, s) => m + s.minutes, 0);
  const waiting = waitingCount();

  const settledCount = a.settled.filter((id) => !S.reopened.includes(id)).length;
  const hero = h(
    "section",
    { class: "hero", "aria-labelledby": "hello" },
    h("h1", { id: "hello" }, waiting ? `Good morning, ${Q.persona.first_name}.` : "All clear."),
    h(
      "p",
      { class: "overnight", id: "overnight" },
      waiting ? `${waiting} waiting on you · about ${remaining} min` : "Nothing is waiting on you.",
      h("span", { class: "quiet" }, ` · ${Q.decisions.length} questions overnight, `),
      link({ view: "settled" }, `${settledCount} decided for you`),
    ),
  );

  // The queue, in the order to work it: one project at a time (projects by how many agents their
  // answers unblock), decisions before quick checks, then by agents unblocked and time waiting.
  // Numbered across projects, because the order is the point.
  const queue = a.sections.map((s) => ({ s, items: [...s.decisions, ...s.check_ins] }));
  // The piles: one per project with work waiting, in agenda order. The first is the recommendation,
  // drawn large with its reason and one Start button, for someone who just wants to begin.
  const piles = queue.filter((g) => g.items.length);
  const agentsLabel = (n: number) => `unblocks ${n} agent${n === 1 ? "" : "s"}`;
  const pileCard = ({ s, items }: (typeof queue)[number], i: number) => {
    const rec = i === 0;
    const name = s.project.name;
    return h(
      "section",
      { class: rec ? "pile rec" : "pile", id: rec ? "start-card" : undefined, "data-project": s.project.id, "aria-labelledby": `pile-${s.project.id}` },
      rec ? h("p", { class: "eyebrow" }, `Start with ${name}`) : null,
      h("h2", { id: `pile-${s.project.id}` }, rec ? `${items.length} question${items.length === 1 ? "" : "s"} · about ${s.minutes} min` : name),
      h("p", { class: "quiet" }, rec ? s.section_reason : `${items.length} · about ${s.minutes} min · ${agentsLabel(s.unblocks)}`),
      h(
        "p",
        { class: "tally" },
        h("span", { "aria-hidden": "true" }, `${GLYPH.decide} ${s.decisions.length} decision${s.decisions.length === 1 ? "" : "s"}   ${GLYPH.check_in} ${s.check_ins.length} quick check${s.check_ins.length === 1 ? "" : "s"}`),
        h("span", { class: "sr-only" }, `${s.decisions.length} decisions, ${s.check_ins.length} quick checks`),
      ),
      rec ? h("ul", { class: "peek" }, ...items.slice(0, 3).map((it) => h("li", {}, headline(it.id)))) : null,
      h(
        "button",
        { type: "button", class: rec ? "primary big" : "ghost", id: rec ? "start" : undefined, onclick: () => startSession(items[0].id) },
        rec ? `Start ${name} →` : `Start ${name}`,
      ),
    );
  };
  const startCard = piles.length
    ? h("div", { class: "piles" }, pileCard(piles[0], 0), piles.length > 1 ? h("div", { class: "other-piles" }, ...piles.slice(1).map((g, i) => pileCard(g, i + 1))) : null)
    : h("p", { class: "quiet all-clear" }, "The firefly is resting; so can you.");

  const agendaList = h("section", { id: "agenda", class: "agenda", "aria-labelledby": "queue-h" }, piles.length ? h("h2", { class: "section-h", id: "queue-h" }, "The whole queue, in order") : null);
  let n = 0;
  for (const { s, items } of queue) {
    if (!items.length) continue;
    agendaList.append(
      h(
        "div",
        { class: "project" },
        h(
          "h2",
          { class: "project-h" },
          h("span", { class: "pname" }, s.project.name),
          h("span", { class: "quiet pmeta" }, `${items.length} · about ${s.minutes} min`),
        ),
        h(
          "ol",
          { class: "items", start: String(n + 1) },
          ...items.map((i) => {
            n++;
            return h(
              "li",
              {},
              h(
                "a",
                { href: hrefFor({ view: "focus", id: i.id }), class: `item${i.id === piles[0]?.items[0]?.id ? " first" : ""}${S.changes[i.id] ? " changed" : ""}${S.pending.includes(i.id) ? " pending" : ""}` },
                h("span", { class: "num", "aria-hidden": "true" }, String(n)),
                h("span", { class: "glyph", "aria-label": ROUTE_LABEL[i.route] }, GLYPH[i.route]),
                h("span", { class: "q" }, headline(i.id)),
                S.changes[i.id] ? h("span", { class: "change-note" }, S.changes[i.id]) : null,
                S.pending.includes(i.id) ? h("span", { class: "change-note" }, "re-checking…") : null,
              ),
            );
          }),
        ),
      ),
    );
  }

  // Answered decisions whose follow-up is still open, so leaving one never loses the loop.
  const open = Object.keys(S.flows).filter((id) => S.answered[id] && unfinished(id));
  const unfinishedList = open.length
    ? h(
        "section",
        { class: "list-block", id: "unfinished" },
        h("h2", { class: "section-h" }, "Waiting for you to finish"),
        h(
          "ol",
          { class: "items" },
          ...open.map((id) => {
            const step = { pushback: "Bug Me pushed back", why: "Bug Me asked why", proposal: "Keep this guidance?", busy: "Working…" }[S.flows[id].phase as "pushback" | "why" | "proposal" | "busy"];
            return h("li", {}, h("a", { href: hrefFor({ view: "focus", id }), class: "item changed" }, h("span", { class: "glyph", "aria-hidden": "true" }, "…"), h("span", { class: "q" }, headline(id)), h("span", { class: "change-note" }, step)));
          }),
        ),
      )
    : null;

  const asideIds = Object.keys(S.punts);
  const asideList = asideIds.length
    ? h(
        "section",
        { class: "list-block", id: "aside" },
        h("h2", { class: "section-h" }, "Set aside"),
        h(
          "ol",
          { class: "items" },
          ...asideIds.map((id) =>
            h(
              "li",
              { class: "aside-item" },
              h("span", { class: "q" }, headline(id)),
              h("q", { class: "aside-reason" }, S.punts[id].reason),
              h("button", { type: "button", class: "ghost small", onclick: () => resume(id) }, "Resume"),
            ),
          ),
        ),
      )
    : null;

  const more = h(
    "nav",
    { class: "more-links", "aria-label": "More" },
    link({ view: "rules" }, "Rules and what Bug Me knows"),
    link({ view: "record" }, "Your record"),
  );
  view.replaceChildren(hero, startCard, agendaList, unfinishedList ?? "", asideList ?? "", more);
}

// ---------- Focus ----------

function renderFocus(view: HTMLElement, id: string): void {
  // A decision that has become settled (and has nothing in progress) is no longer the person's.
  if (!S.answered[id] && !unfinished(id) && routeOf(id) === "settle" && !S.punts[id]) {
    go({ view: "settled" });
    return;
  }
  const d = byId.get(id)!;
  S.current = id;
  S.sessionProject = d.project;
  const a = agenda();
  const section = a.sections.find((s) => s.project.id === d.project);
  const items = section ? [...section.decisions, ...section.check_ins] : [];
  const pos = items.findIndex((i) => i.id === id);
  const project = Q.persona.projects.find((p) => p.id === d.project)!;
  const bar = h(
    "div",
    { class: "focus-bar" },
    link({ view: "home" }, "← Home"),
    h("span", { class: "quiet" }, `${project.name}${pos >= 0 ? ` · ${pos + 1} of ${items.length}` : ""}`),
  );
  view.replaceChildren(bar, h("div", { id: "now", class: "now", tabindex: "-1" }));
  renderNow();
}

// ---------- Between projects ----------

function renderBetween(view: HTMLElement, projectId: string): void {
  const a = agenda();
  const stillOpen =
    Object.keys(S.punts).filter((id) => byId.get(id)?.project === projectId).length +
    Object.keys(S.flows).filter((id) => byId.get(id)?.project === projectId && S.answered[id] && unfinished(id)).length;
  const finished = Q.persona.projects.find((p) => p.id === projectId);
  const n = nextInSession(a, null);
  const nextSection = a.sections.find((s) => s.project.id === n.project);
  view.replaceChildren(
    h(
      "section",
      { class: "between" },
      h("p", { class: "glyph-big", "aria-hidden": "true" }, GLYPH.settle),
      h("h1", {}, stillOpen ? `${finished?.name}'s active queue is clear.` : `${finished?.name} is done.`),
      stillOpen ? h("p", { class: "quiet" }, `${stillOpen} set aside or waiting for you to finish.`) : null,
      nextSection
        ? h(
            "div",
            { class: "start-row" },
            h("button", { type: "button", class: "primary big", onclick: () => n.id && startSession(n.id) }, `Next: ${nextSection.project.name}`),
            h("span", { class: "quiet" }, `${nextSection.decisions.length + nextSection.check_ins.length} waiting · about ${estimateMinutes(nextSection.decisions.length, nextSection.check_ins.length)} min`),
          )
        : h("p", {}, "That's everything waiting on you."),
      link({ view: "home" }, "Back to the overview"),
    ),
  );
}

// ---------- Decided for you ----------

function renderSettledView(view: HTMLElement): void {
  const a = agenda();
  const ids = a.settled.filter((id) => !S.reopened.includes(id));
  const list = h("ol", { id: "settled", class: "settled" });
  if (!ids.length) list.append(h("li", {}, "Nothing decided without you yet."));
  for (const id of ids) {
    const d = byId.get(id)!;
    const c = S.cards[id] as Card;
    const opt = d.options.find((o) => o.key === c.settle_option);
    list.append(
      h(
        "li",
        { class: S.changes[id] ? "changed" : "" },
        h("span", { class: "glyph", "aria-hidden": "true" }, GLYPH.settle),
        h("div", { class: "settled-body" }, h("span", { class: "q" }, (c.headline || d.question).replace(/\?$/, "")), h("span", { class: "picked" }, opt?.label ?? c.settle_option)),
        h("details", { class: "why-s" }, h("summary", {}, "Why"), h("p", {}, `${c.why_here} · ${SOURCE_LABEL[c.source]}`)),
        S.changes[id] ? h("span", { class: "change-note" }, S.changes[id]) : null,
        S.pending.includes(id) ? h("span", { class: "change-note" }, "re-checking…") : null,
        h(
          "div",
          { class: "marks" },
          h("button", { type: "button", onclick: () => undo(id) }, "Undo"),
          markButton(id, "should_have_asked", "You should have asked me"),
          markButton(id, "wrong_call", "Right to decide, wrong call"),
        ),
      ),
    );
  }
  view.replaceChildren(
    h("section", { class: "page" }, h("h1", {}, "Decided for you"), h("p", { class: "quiet" }, "Only what is reversible, cheap, and cleared by one of your rules."), list),
  );
}

// ---------- Rules and what Bug Me knows ----------

function renderRulesView(view: HTMLElement): void {
  const facts = h("ul", { id: "facts", class: "facts" });
  for (const f of S.facts) facts.append(h("li", { class: S.newFacts.includes(f.id) ? "new" : "" }, f.text, h("span", { class: "src" }, f.source)));
  view.replaceChildren(
    h(
      "section",
      { class: "page" },
      h("h1", {}, "Your rules"),
      h("p", { class: "quiet" }, "Edit one and the decisions it touches are checked again."),
      h("ol", { id: "rules", class: "rules" }),
      h("h2", { class: "section-h" }, "What Bug Me knows about how you decide"),
      facts,
      h("h2", { class: "section-h" }, "How to work with me"),
      h("ul", { id: "note", class: "note" }, ...Q.persona.how_to_work_with_me.map((t) => h("li", {}, t))),
      h("p", { class: "quiet", id: "note-source" }, Q.persona.how_to_work_with_me_source),
    ),
  );
  renderRules();
}

export function renderRules(): void {
  const root = document.getElementById("rules");
  if (!root) return;
  root.replaceChildren();
  for (const r of S.rules) {
    const li = h("li", {}, h("span", { class: "rid" }, r.id));
    if (ruleDraft?.id === r.id) {
      // The draft lives outside the DOM, so a re-render (from a re-route finishing) never wipes it.
      const draft = ruleDraft;
      const ta = h("textarea", { "aria-label": `Rule ${r.id}` }) as HTMLTextAreaElement;
      ta.value = draft.text;
      ta.addEventListener("input", () => (draft.text = ta.value));
      const saveBtn = h("button", { type: "button", class: "ghost", onclick: () => void editRule(r.id, ta.value) }, "Save and re-route");
      const cancel = h("button", { type: "button", class: "linkish", onclick: () => { ruleDraft = null; renderRules(); } }, "cancel");
      li.append(h("div", {}, ta, draft.error ? h("p", { class: "change-note", role: "alert" }, draft.error) : null, h("div", { class: "row" }, saveBtn, cancel)));
      root.append(li);
      if (draft.focus) {
        draft.focus = false;
        ta.focus();
      }
      continue;
    }
    const btn = h("button", { type: "button", class: "rtext", title: "Edit this rule", "aria-label": `Edit rule ${r.id}: ${r.text}` }, r.text);
    btn.addEventListener("click", () => {
      ruleDraft = { id: r.id, text: r.text, error: "", focus: true };
      renderRules();
    });
    li.append(btn);
    root.append(li);
  }
}

// ---------- The record ----------

function renderRecordView(view: HTMLElement): void {
  view.replaceChildren(
    h(
      "section",
      { class: "page" },
      h("h1", {}, "Your record"),
      h(
        "p",
        { id: "record-summary" },
        `${S.record.filter((r) => r.kind === "answer").length} answers, ${Object.keys(S.punts).length} set aside, ${S.record.filter((r) => r.kind === "mark").length} marks, ${S.record.length} events. Every guess made before an answer is kept with the answer and your reason. It stays in this browser.`,
      ),
      h("div", { class: "row" }, h("button", { type: "button", id: "export", class: "ghost" }, "Export JSON"), h("button", { type: "button", id: "reset", class: "ghost" }, "Start the morning over")),
    ),
  );
}

// ---------- Dispatch ----------

export function render(): void {
  const route = currentRoute();
  // Leaving a card cancels its answer if it is still in the Undo window.
  cancelPendingUnlessOn(route.view === "focus" ? route.id : null);
  renderBar(route);
  const view = $("view");
  if (route.view !== "focus") {
    setVoiceTarget(null); // only a decision card has a box for speech
    if (F) setF(null);
  }
  if (route.view === "home") renderHome(view);
  else if (route.view === "focus") renderFocus(view, route.id);
  else if (route.view === "between") renderBetween(view, route.project);
  else if (route.view === "settled") renderSettledView(view);
  else if (route.view === "rules") renderRulesView(view);
  else renderRecordView(view);
  tourAfterRender();
}

/** Replace the rule being edited (actions.ts saves or rejects a draft from outside this module). */
export function setRuleDraft(d: typeof ruleDraft): void {
  ruleDraft = d;
}
