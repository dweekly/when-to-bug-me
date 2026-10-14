// Every screen except the decision card itself. One view at a time, chosen by the URL (router.ts):
// home (the overview: nothing to decide here), focus (one decision; card.ts draws it), between (a
// change of project), the secondary views for what Bug Me decided, the rules, and the record, and
// Dispatch (dispatch.ts, docs/STAGE-8.md).
// render() redraws the bar and the current view from state.

import { estimateMinutes, nextInSession } from "../shared/agenda";
import type { Mood } from "../shared/lifecycle";
import type { Card, RouteKind } from "../shared/types";
import { editRule, resume, startSession, undo } from "./actions";
import { markButton, renderNow } from "./card";
import { type Mood as Mood6, setGlowMood, setVoiceTarget } from "./voice";
import { GLYPH, ROUTE_LABEL, SOURCE_LABEL, agenda, routeOf } from "./derive";
import { $, h } from "./dom";
import { type Route, go, hrefFor, parseRoute } from "./router";
import { F, Q, S, byId, isCard, setF, unfinished } from "./state";
import { openToursMenu, tourAfterRender } from "./tour";
import { renderDispatchView } from "./dispatch";
import { betweenReflection, renderReviewView } from "./reflect";

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
      nav({ view: "dispatch" }, "Dispatch"),
      nav({ view: "settled" }, `Decided for you${settledCount ? ` · ${settledCount}` : ""}`),
      nav({ view: "rules" }, "Rules"),
      nav({ view: "record" }, "Record"),
      // The demos (guided tours) script Jordan's decisions, so the owner's live queue has none.
      Q.owner ? null : h("button", { type: "button", class: "nav tours-btn", onclick: () => openToursMenu() }, "Demos"),
    ),
    // The owner's page says it is the real queue; the simulation says what's real on the explainer and per turn.
    ...(Q.owner ? [h("span", { class: "synthetic live-label", title: "Real questions from your own sessions." }, "Live · your real queue")] : []),
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
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const agentsLabel = (n: number) => (n ? `unblocks ${plural(n, "agent")}` : "unblocks no agents");
  const pileCard = ({ s, items }: (typeof queue)[number], i: number) => {
    const rec = i === 0;
    const name = s.project.name;
    return h(
      "section",
      { class: rec ? "pile rec" : "pile", id: rec ? "start-card" : undefined, "data-project": s.project.id, "aria-labelledby": `pile-${s.project.id}` },
      rec ? h("p", { class: "eyebrow" }, "Suggested first") : null,
      h("h2", { id: `pile-${s.project.id}` }, `${name} project`),
      h("p", { class: "quiet" }, `${plural(items.length, "question")} · about ${s.minutes} min · ${rec ? s.section_reason : agentsLabel(s.unblocks)}`),
      h(
        "p",
        { class: "tally" },
        h("span", { "aria-hidden": "true" }, [s.decisions.length ? `${GLYPH.decide} ${plural(s.decisions.length, "decision")}` : "", s.check_ins.length ? `${GLYPH.check_in} ${plural(s.check_ins.length, "quick check")}` : ""].filter(Boolean).join("   ")),
        h("span", { class: "sr-only" }, [s.decisions.length ? plural(s.decisions.length, "decision") : "", s.check_ins.length ? plural(s.check_ins.length, "quick check") : ""].filter(Boolean).join(", ")),
      ),
      rec ? h("ul", { class: "peek" }, ...items.slice(0, 3).map((it) => h("li", {}, headline(it.id)))) : null,
      h(
        "button",
        { type: "button", class: rec ? "primary big" : "ghost", id: rec ? "start" : undefined, onclick: () => startSession(items[0].id) },
        rec ? `Begin ${name} →` : `Begin ${name}`,
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
    link({ view: "review" }, "Weekly review sketch"),
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
      ...betweenReflection(projectId, nextSection?.project.id ?? null),
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
// docs/STAGE-6.md, section 3: one sentence says what these are, once; the jobs are grouped by kind of
// work, each group closed until opened; one short line per job (what was done, and which project);
// the same three icon actions on every row. A group's rule shows only on request, and only when every
// job in it was allowed by that one rule. No route glyphs, no rule codes, no per-row Why.

type WorkKind = "branches" | "updates" | "formatting" | "flaky-tests" | "other";

const WORK: Record<WorkKind, { title: string; icon: string }> = {
  branches: { title: "Merged branches", icon: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-12 7"/>' },
  updates: { title: "Patch updates", icon: '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8M12 13v8"/>' },
  formatting: { title: "Formatting and lint", icon: '<path d="M4 6h16M4 10h10M4 14h16M4 18h8"/>' },
  "flaky-tests": { title: "Flaky tests", icon: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 001.8 3h10.4a2 2 0 001.8-3l-5-9V3"/><path d="M7.5 15h9"/>' },
  other: { title: "Other small jobs", icon: '<circle cx="12" cy="12" r="8"/><path d="M8 12l3 3 5-6"/>' },
};
const WORK_ORDER: WorkKind[] = ["branches", "updates", "formatting", "flaky-tests", "other"];

const ACT_ICON = {
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
  ask: '<path d="M21 12a8 8 0 01-11.5 7.2L4 21l1.8-5.5A8 8 0 1121 12z"/><path d="M12 8v4M12 15.5v.01"/>',
  disagree: '<path d="M17 14V3M10 15l-1 5a2 2 0 003.7 1L17 14h2a2 2 0 002-2V5a2 2 0 00-2-2H7.6a2 2 0 00-2 1.7l-1.4 8A2 2 0 006.2 15z"/>',
};

/** A line icon from static markup in this file (never from data). */
function icon(paths: string): HTMLElement {
  const span = h("span", { class: "dicon", "aria-hidden": "true" });
  span.innerHTML = `<svg viewBox="0 0 24 24">${paths}</svg>`;
  return span;
}

/** Turn a text button into the icon-and-label form: the visible label stays inside the accessible name. */
function iconAction(btn: HTMLElement, paths: string, label: string, name: string): HTMLElement {
  btn.replaceChildren(icon(paths), h("span", { class: "dlabel" }, label));
  btn.setAttribute("aria-label", name);
  btn.setAttribute("title", name);
  return btn;
}

/** Groups the person has opened, so a re-render (an Undo, a mark) doesn't close them. Kept per
 *  morning: a fresh morning (a tour, starting over) replaces S and starts with every group closed. */
const openGroups = new Set<WorkKind>();
let openGroupsFor: unknown = null;

function renderSettledView(view: HTMLElement): void {
  if (openGroupsFor !== S) {
    openGroups.clear();
    openGroupsFor = S;
  }
  const a = agenda();
  const ids = a.settled.filter((id) => !S.reopened.includes(id));
  const root = h("div", { id: "settled", class: "decided" });
  if (!ids.length) root.append(h("p", { class: "quiet" }, "Nothing decided without you yet."));
  const groups = new Map<WorkKind, string[]>();
  for (const id of ids) {
    const w = byId.get(id)!.work;
    const kind: WorkKind = w && w in WORK ? w : "other";
    groups.set(kind, [...(groups.get(kind) ?? []), id]);
  }
  for (const kind of WORK_ORDER) {
    const gids = groups.get(kind);
    if (!gids?.length) continue;
    const cards = gids.map((id) => S.cards[id] as Card);
    const projects = [...new Set(gids.map((id) => byId.get(id)!.project))].map((p) => Q.persona.projects.find((x) => x.id === p)?.name ?? p);
    const rules = new Set(cards.map((c) => c.clearing_rule).filter(Boolean));
    const rule = rules.size === 1 && cards.every((c) => c.clearing_rule) ? [...rules][0] : "";
    const rows = h("ul", { class: "drows" });
    for (const id of gids) rows.append(settledRow(id));
    const g = h(
      "details",
      { class: "dgroup", "data-work": kind, open: openGroups.has(kind) },
      h(
        "summary",
        {},
        icon(WORK[kind].icon),
        h("span", { class: "dhead" }, h("span", { class: "dtitle" }, WORK[kind].title), h("span", { class: "dsum" }, `${gids.length} job${gids.length === 1 ? "" : "s"} · ${projects.join(", ")}`)),
        h("span", { class: "dchev", "aria-hidden": "true" }),
      ),
      rule ? h("details", { class: "drule" }, h("summary", {}, "Why Bug Me could do these"), h("p", {}, `Your rule: “${rule}”`)) : null,
      rows,
    );
    g.addEventListener("toggle", () => ((g as HTMLDetailsElement).open ? openGroups.add(kind) : openGroups.delete(kind)));
    root.append(g);
  }
  const sources = [...new Set(ids.map((id) => SOURCE_LABEL[(S.cards[id] as Card).source]))];
  view.replaceChildren(
    h(
      "section",
      { class: "page" },
      h("h1", {}, "Decided for you"),
      h("p", { class: "quiet" }, ids.length ? `${ids.length} small job${ids.length === 1 ? "" : "s"}, each one undoable and covered by one of your rules.` : "Only what is reversible, cheap, and covered by one of your rules."),
      root,
      sources.length ? h("p", { class: "dsource" }, `Decided by: ${sources.join(", ")}.`) : null,
    ),
  );
}

/** One job: what was done (the fast model's past-tense line; without one, the question and the option
 *  Bug Me took), its project, and the actions. */
function settledRow(id: string): HTMLElement {
  const d = byId.get(id)!;
  const c = S.cards[id] as Card;
  const asked = (c.headline || d.question).replace(/\?$/, "");
  const done = c.done?.[c.settle_option] || "";
  const picked = d.options.find((o) => o.key === c.settle_option)?.label ?? c.settle_option;
  const project = Q.persona.projects.find((x) => x.id === d.project)?.name ?? d.project;
  return h(
    "li",
    { class: S.changes[id] ? "drow changed" : "drow", "data-id": id },
    h(
      "span",
      { class: "dwhat" },
      c.emoji ? h("span", { class: "demoji", "aria-hidden": "true" }, c.emoji) : null,
      h("span", { class: "ddone" }, done || asked),
      done ? null : h("span", { class: "dpick" }, ` → ${picked}`),
      h("span", { class: "dproj" }, ` · ${project}`),
      done ? h("span", { class: "sr-only" }, `. Asked: ${asked}`) : null,
      S.changes[id] ? h("span", { class: "change-note" }, S.changes[id]) : null,
      S.pending.includes(id) ? h("span", { class: "change-note" }, "re-checking…") : null,
    ),
    h(
      "span",
      { class: "dacts" },
      iconAction(h("button", { type: "button", class: "dundo", onclick: () => undo(id) }), ACT_ICON.undo, "Undo", "Undo: put it back and ask me"),
      iconAction(markButton(id, "should_have_asked", "You should have asked me"), ACT_ICON.ask, "Ask!", "Ask! You should have asked me"),
      iconAction(markButton(id, "wrong_call", "Right to decide, wrong call"), ACT_ICON.disagree, "Disagree", "Disagree: right to decide, wrong call"),
    ),
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
      li.append(h("div", {}, ta, draft.error ? h("p", { class: "change-note", role: "alert" }, draft.error) : null, h("div", { class: "row" }, cancel, saveBtn)));
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
      h("p", { class: "quiet" }, link({ view: "review" }, "Weekly review sketch →")),
    ),
  );
}

// ---------- Dispatch ----------

export function render(): void {
  const route = currentRoute();
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
  else if (route.view === "dispatch") renderDispatchView(view, route.id);
  else if (route.view === "review") renderReviewView(view);
  else renderRecordView(view);
  tourAfterRender();
}

/** Replace the rule being edited (actions.ts saves or rejects a draft from outside this module). */
export function setRuleDraft(d: typeof ruleDraft): void {
  ruleDraft = d;
}
