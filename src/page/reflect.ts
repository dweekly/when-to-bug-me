// Reflection prompts (docs/STAGE-10.md, 10c). On the change-of-project screen: one dismissible line
// suggesting a break after a demanding stretch, and now and then "Were those worth your time?" with three
// taps. And #/review, a sketch of the weekly review from this browser's record. What each change of
// project offers is decided once, when Next is pressed (recordTransition), and kept in S.transitions, so
// rendering, reloading, Back and polling never re-decide, re-prompt or log twice. Times are estimates.

import { MINUTES_PER_CHECK_IN, MINUTES_PER_DECISION } from "../shared/constants";
import { duration, money } from "../shared/dispatch";
import { FEEDBACK_CHOICES, type FeedbackChoice, SYNTHETIC_STATED_PRIORITIES, type Transition, planTransition, reviewOf } from "../shared/reflection";
import { GLYPH, agenda } from "./derive";
import { announce, h } from "./dom";
import { hrefFor } from "./router";
import { Q, S, byId, log, save } from "./state";
import { render } from "./views";

const projectOf = (id: string) => byId.get(id)?.project;
const projectName = (id: string | null) => (id && Q.persona.projects.find((p) => p.id === id)?.name) || id || "";

/** Count a change of project. Called by Next (actions.ts) as it leaves a finished project. */
export function recordTransition(from: string, to: string | null): void {
  const t = planTransition({ transitions: S.transitions, record: S.record, from, to, projectOf, at: new Date().toISOString() });
  if (!t) return;
  S.transitions.push(t);
  log("transition", { transition: t.id, from, to, covered: t.covered, stretch_minutes_est: t.stretch_minutes_est, break_offered: t.breakOffered, feedback_asked: t.feedbackAsked });
  save();
}

/** The change of project a #/between/<project> screen shows: the latest one out of that project. */
function transitionFor(projectId: string): Transition | undefined {
  return [...S.transitions].reverse().find((t) => t.from === projectId);
}

function feedback(t: Transition, choice: FeedbackChoice): void {
  if (t.feedback || t.feedbackDismissed) return;
  t.feedback = choice;
  log("feedback", { transition: t.id, project: t.from, choice, covered: t.covered });
  save();
  announce("Noted.");
  render();
}

function dismissFeedback(t: Transition): void {
  if (t.feedback || t.feedbackDismissed) return;
  t.feedbackDismissed = true;
  log("feedback_dismissed", { transition: t.id, project: t.from });
  save();
  render();
}

function dismissBreak(t: Transition): void {
  if (t.breakDismissed) return;
  t.breakDismissed = true;
  log("break_dismissed", { transition: t.id });
  save();
  render();
}

/** A line icon from static markup in this file (never from data). */
function svg(paths: string, cls = "ricon"): HTMLElement {
  const span = h("span", { class: cls, "aria-hidden": "true" });
  span.innerHTML = `<svg viewBox="0 0 24 24">${paths}</svg>`;
  return span;
}
const STAND = '<circle cx="12" cy="4.5" r="2"/><path d="M12 7.5v7M12 14.5l-3 6.5M12 14.5l3 6.5M7 10.5l5-2 5 2"/>';
const CLOSE = '<path d="M6 6l12 12M18 6L6 18"/>';

function closeButton(label: string, onclick: () => void): HTMLElement {
  return h("button", { type: "button", class: "rclose", "aria-label": label, title: label, onclick }, svg(CLOSE, "rx"));
}

const EST_TITLE = "Estimated from the kind of question, not timed.";
const est = () => h("abbr", { class: "est", title: EST_TITLE }, "est.");

/** What the change-of-project screen adds: the feedback taps, then the break line. Empty when neither applies. */
export function betweenReflection(projectId: string, nextProject: string | null): HTMLElement[] {
  const t = transitionFor(projectId);
  if (!t) return [];
  const out: HTMLElement[] = [];
  if (t.feedbackAsked && !t.feedbackDismissed) {
    const n = t.covered.length;
    out.push(
      t.feedback
        ? h("p", { class: "worth noted", id: "worth" }, `${FEEDBACK_CHOICES.find((c) => c.key === t.feedback)!.glyph} Noted.`)
        : h(
            "section",
            { class: "worth", id: "worth", "aria-labelledby": "worth-q" },
            h("p", { id: "worth-q" }, n === 1 ? "Was that one worth your time?" : `Were those ${n} worth your time?`, closeButton("Not now", () => dismissFeedback(t))),
            h(
              "div",
              { class: "worth-taps" },
              ...FEEDBACK_CHOICES.map((c) => h("button", { type: "button", class: "chip-btn", "data-choice": c.key, onclick: () => feedback(t, c.key) }, h("span", { class: "wglyph", "aria-hidden": "true" }, c.glyph), c.label)),
            ),
          ),
    );
  }
  if (t.breakOffered && !t.breakDismissed) {
    const next = projectName(nextProject);
    out.push(
      h(
        "p",
        { class: "break-line", id: "break-line" },
        svg(STAND),
        h("span", {}, `~${t.stretch_minutes_est} min of real decisions `, est(), ` · ${next ? `Stand up before ${next}?` : "Stand up?"}`),
        closeButton("Dismiss", () => dismissBreak(t)),
      ),
    );
  }
  return out;
}

// ---------- #/review ----------

export function renderReviewView(view: HTMLElement): void {
  const priorities = Q.persona.synthetic ? SYNTHETIC_STATED_PRIORITIES : null;
  const r = reviewOf({ record: S.record, projectOf, projects: Q.persona.projects, priorities });
  const a = agenda();
  const settledNow = a.settled.filter((id) => !S.reopened.includes(id)).length;
  const waitingNow = a.sections.reduce((n, s) => n + s.decisions.length + s.check_ins.length, 0);
  const asked = r.asked.decide + r.asked.check_in;

  // Where the time went, by project, in the order of the stated priorities.
  const max = Math.max(1, ...r.projects.map((p) => p.minutes_est));
  const finding = r.top
    ? `Most time went to ${r.top.name}${r.top.rank ? `, your #${r.top.rank}` : ""}.`
    : "Nothing answered yet this morning.";
  const projects = h(
    "section",
    { class: "rv-block", id: "rv-projects", "aria-labelledby": "rv-time" },
    h("h2", { class: "section-h", id: "rv-time" }, "Where the time went"),
    h("p", { class: "rv-finding" }, finding),
    h(
      "ol",
      { class: "rv-bars" },
      ...r.projects.map((p) =>
        h(
          "li",
          { "data-project": p.id },
          h("span", { class: "rv-rank", title: p.rank ? "Stated priority" : "" }, p.rank ? `#${p.rank}` : ""),
          h("span", { class: "rv-name" }, p.name),
          h(
            "span",
            { class: "rv-track" },
            h("span", { class: "rv-fill", style: `width:${Math.round((p.minutes_est / max) * 100)}%` }),
          ),
          h("span", { class: "rv-min" }, p.minutes_est ? `~${p.minutes_est}m` : "—"),
          h("span", { class: "rv-dots", "aria-label": `${p.decided} decided, ${p.checked} quick checks` }, GLYPH.decide.repeat(p.decided) + GLYPH.check_in.repeat(p.checked)),
        ),
      ),
    ),
    h(
      "p",
      { class: "rv-note" },
      priorities ? "#: Jordan's stated priorities (synthetic). " : "",
      "Minutes ",
      est(),
      `: ${GLYPH.decide} ${duration(MINUTES_PER_DECISION)}, ${GLYPH.check_in} ${duration(MINUTES_PER_CHECK_IN)} each.`,
    ),
  );

  // Settled versus asked: one mark per question this morning.
  const cells = [
    ...Array.from({ length: r.asked.decide }, () => ["decide", GLYPH.decide]),
    ...Array.from({ length: r.asked.check_in }, () => ["check", GLYPH.check_in]),
    ...Array.from({ length: settledNow }, () => ["settled", GLYPH.settle]),
    ...Array.from({ length: waitingNow }, () => ["waiting", "◌"]),
  ];
  const fb = r.feedback;
  const fbTotal = fb.all + fb.some + fb.none;
  const split = h(
    "section",
    { class: "rv-block", id: "rv-split", "aria-labelledby": "rv-split-h" },
    h("h2", { class: "section-h", id: "rv-split-h" }, "Settled or asked"),
    h("p", { class: "rv-waffle", "aria-hidden": "true" }, ...cells.map(([k, g]) => h("span", { class: `rv-cell ${k}` }, g))),
    h(
      "ul",
      { class: "rv-legend" },
      h("li", {}, h("span", { class: "rv-n" }, String(asked)), " asked you: ", `${GLYPH.decide} ${r.asked.decide} · ${GLYPH.check_in} ${r.asked.check_in}`),
      h("li", {}, h("span", { class: "rv-n" }, String(settledNow)), ` ${GLYPH.settle} settled for you `, h("span", { class: "rv-now", title: "From the queue as it stands now" }, "now")),
      waitingNow ? h("li", {}, h("span", { class: "rv-n" }, String(waitingNow)), " ◌ still waiting ", h("span", { class: "rv-now", title: "From the queue as it stands now" }, "now")) : null,
    ),
    fbTotal
      ? h(
          "p",
          { class: "rv-worth", id: "rv-worth" },
          "Worth your time? ",
          ...FEEDBACK_CHOICES.map((c) => h("span", { class: "rv-tally", title: c.label }, `${c.glyph} ${fb[c.key]}`)),
        )
      : null,
  );

  // Dispatch: reported time and cost against the brief's estimate.
  const dmax = Math.max(1, ...r.dispatch.map((d) => Math.max(d.estimate_minutes, d.minutes ?? 0)));
  const dispatch = h(
    "section",
    { class: "rv-block", id: "rv-dispatch", "aria-labelledby": "rv-dispatch-h" },
    h("h2", { class: "section-h", id: "rv-dispatch-h" }, "Dispatch against estimate"),
    r.dispatch.length
      ? h(
          "ul",
          { class: "rv-briefs" },
          ...r.dispatch.map((d) => {
            const reported = d.outcome !== null;
            const over = d.minutes !== null && d.minutes > d.estimate_minutes;
            return h(
              "li",
              { "data-brief": d.brief },
              h("span", { class: "rv-bname" }, d.headline || d.brief),
              // The reported time as a bar, the estimate as a tick on the same scale.
              h(
                "span",
                { class: "rv-dtrack", "aria-hidden": "true" },
                d.minutes === null ? null : h("span", { class: `rv-took ${over ? "over" : "under"}`, style: `width:${Math.round((d.minutes / dmax) * 100)}%` }),
                h("span", { class: "rv-est", style: `left:${Math.round((d.estimate_minutes / dmax) * 100)}%` }),
              ),
              h(
                "span",
                { class: "rv-dfacts" },
                !reported ? `no report yet · ~${duration(d.estimate_minutes)} est.` : d.minutes === null ? `${d.outcome} · time unknown of ~${duration(d.estimate_minutes)}` : `${duration(d.minutes)} of ~${duration(d.estimate_minutes)}`,
                reported ? ` · ${d.cost_usd === null ? "cost not reported" : money(d.cost_usd)}` : "",
                d.synthetic ? h("span", { class: "meta-chip", title: "The public demo's example report, not a real session." }, "synthetic") : null,
              ),
            );
          }),
        )
      : h("p", { class: "quiet" }, "No briefs sent yet. ", h("a", { href: hrefFor({ view: "dispatch" }) }, "Dispatch")),
    r.dispatch.length ? h("p", { class: "rv-note" }, "Bar: reported time. Tick: the brief's estimate.") : null,
  );

  view.replaceChildren(
    h(
      "section",
      { class: "page review" },
      h("p", { class: "rv-eyebrow" }, "A sketch of the weekly review, from this morning's record"),
      h("h1", {}, "Where the morning went"),
      projects,
      split,
      dispatch,
    ),
  );
}
