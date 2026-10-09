// Every screen except the decision card itself. One view at a time, chosen by the URL (router.ts):
// home (the overview: nothing to decide here), focus (one decision; card.ts draws it), between (a
// change of project), and the secondary views for what Bug Me decided, the rules, and the record.
// render() redraws the bar and the current view from state.

import { estimateMinutes, nextInSession, overnightTotals } from "../shared/agenda";
import type { Mood } from "../shared/lifecycle";
import type { Card, RouteKind } from "../shared/types";
import { editRule, resume, startSession, undo } from "./actions";
import { markButton, renderNow, stopVoiceIfMicGone, stopVoiceUnlessFor } from "./card";
import { GLYPH, ROUTE_LABEL, SOURCE_LABEL, agenda, routeOf } from "./derive";
import { $, h } from "./dom";
import { type Route, go, hrefFor, parseRoute } from "./router";
import { renderSky } from "./sky";
import { F, Q, S, byId, isCard, setF, unfinished } from "./state";

/** A rule being edited, kept across re-renders so an async update never wipes the draft. */
let ruleDraft: { id: string; text: string; error: string; focus: boolean } | null = null;

/** Which agenda rows on home are expanded. Per visit only. */
const expanded = new Set<string>();

/** Glow level at which the firefly is delighted rather than pleased. Heuristic, near the top of 0..1. */
const DELIGHTED_AT = 0.85;

/** The firefly's six drawn moods (public/firefly/*.svg), picked from the glow state. */
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
  $("bar").replaceChildren(
    h(
      "a",
      { href: "#/", class: "brand", title: status[asset] },
      h("img", { src: `/firefly/${asset}.svg`, alt: `Bug Me's firefly. ${status[asset]}`, width: 40, height: 40, class: "firefly", "data-mood": asset }),
      h("span", { class: "wordmark" }, "Bug Me"),
    ),
    h(
      "nav",
      { "aria-label": "Views" },
      nav({ view: "home" }, "Home"),
      nav({ view: "settled" }, `Decided for you${settledCount ? ` · ${settledCount}` : ""}`),
      nav({ view: "rules" }, "Rules"),
      nav({ view: "record" }, "Record"),
    ),
    h("a", { href: "/#real", class: "synthetic", title: "Everything here is made up. See what is real." }, { live: "Synthetic · live Claude", recorded: "Synthetic · recorded Claude", fake: "Synthetic · code stand-in" }[Q.mode]),
  );
}

// ---------- Home ----------

function renderHome(view: HTMLElement): void {
  const a = agenda();
  const routes0 = Object.fromEntries(Q.cards.filter(isCard).map((c) => [c.id, c.route])) as Record<string, RouteKind>;
  const t = overnightTotals(routes0);
  const remaining = a.sections.reduce((m, s) => m + s.minutes, 0);
  const waiting = waitingCount();
  const start = nextInSession(a, null);

  const hero = h(
    "section",
    { class: "hero", "aria-labelledby": "hello" },
    renderSky(),
    h("h1", { id: "hello" }, waiting ? `Good morning, ${Q.persona.first_name}.` : "All clear."),
    h(
      "p",
      { class: "overnight", id: "overnight" },
      `${Q.decisions.length} questions overnight`,
      h(
        "span",
        { class: "tally", "aria-label": `${t.settle} settled for you, ${t.check_in} quick checks, ${t.decide} decisions` },
        h("span", { "aria-hidden": "true" }, `  ·  ${GLYPH.settle} ${t.settle}   ${GLYPH.check_in} ${t.check_in}   ${GLYPH.decide} ${t.decide}`),
      ),
    ),
    waiting
      ? h(
          "div",
          { class: "start-row" },
          h("button", { type: "button", class: "primary big", id: "start", onclick: () => start.id && startSession(start.id) }, "Start"),
          h("span", { class: "quiet" }, `${waiting} waiting · about ${remaining} min`),
        )
      : h("p", { class: "quiet" }, "Nothing is waiting on you. The firefly is resting; so can you."),
  );

  const agendaList = h("section", { id: "agenda", class: "agenda", "aria-label": "Your agenda" });
  for (const s of a.sections) {
    const items = [...s.decisions, ...s.check_ins];
    const open = expanded.has(s.project.id);
    const row = h(
      "button",
      {
        type: "button",
        class: "project-row",
        "aria-expanded": String(open),
        onclick: () => {
          if (open) expanded.delete(s.project.id);
          else expanded.add(s.project.id);
          render();
        },
      },
      h("span", { class: "pname" }, s.project.name),
      h("span", { class: "pcounts", "aria-label": `${s.decisions.length} decisions, ${s.check_ins.length} quick checks` }, h("span", { "aria-hidden": "true" }, `${GLYPH.decide} ${s.decisions.length}   ${GLYPH.check_in} ${s.check_ins.length}`)),
      h("span", { class: "quiet pmin" }, `${s.minutes} min`),
      h("span", { class: "chev", "aria-hidden": "true" }, open ? "–" : "+"),
    );
    const block = h("div", { class: "project" }, row, h("p", { class: "preason" }, s.section_reason));
    if (open) {
      block.append(
        h(
          "ol",
          { class: "items" },
          ...items.map((i) =>
            h(
              "li",
              {},
              h(
                "a",
                { href: hrefFor({ view: "focus", id: i.id }), class: `item${S.changes[i.id] ? " changed" : ""}${S.pending.includes(i.id) ? " pending" : ""}` },
                h("span", { class: "glyph", "aria-label": ROUTE_LABEL[i.route] }, GLYPH[i.route]),
                h("span", { class: "q" }, headline(i.id)),
                S.changes[i.id] ? h("span", { class: "change-note" }, S.changes[i.id]) : null,
                S.pending.includes(i.id) ? h("span", { class: "change-note" }, "re-checking…") : null,
              ),
            ),
          ),
        ),
      );
    }
    agendaList.append(block);
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

  const settledCount = a.settled.filter((id) => !S.reopened.includes(id)).length;
  const more = h(
    "nav",
    { class: "more-links", "aria-label": "More" },
    link({ view: "settled" }, `${GLYPH.settle} ${settledCount} decided for you`),
    link({ view: "rules" }, "Rules and what Bug Me knows"),
    link({ view: "record" }, "Your record"),
  );
  view.replaceChildren(hero, agendaList, unfinishedList ?? "", asideList ?? "", more);
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
  renderBar(route);
  const view = $("view");
  if (route.view !== "focus") {
    stopVoiceUnlessFor("");
    if (F) setF(null);
  }
  if (route.view === "home") renderHome(view);
  else if (route.view === "focus") renderFocus(view, route.id);
  else if (route.view === "between") renderBetween(view, route.project);
  else if (route.view === "settled") renderSettledView(view);
  else if (route.view === "rules") renderRulesView(view);
  else renderRecordView(view);
  stopVoiceIfMicGone(); // whatever view this is, dictation never outlives its visible microphone
}

/** Replace the rule being edited (actions.ts saves or rejects a draft from outside this module). */
export function setRuleDraft(d: typeof ruleDraft): void {
  ruleDraft = d;
}
