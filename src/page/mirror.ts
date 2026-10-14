// Questions mirrored from Claude Code sessions by the hook (docs/STAGE-10.md, 10d). They're shown on
// /me, briefed and routed, but answered only in the terminal: the card has no decide button, no
// conversation and nothing to send down. They sit apart from the agenda (which orders what Bug Me
// brings you to decide) in their own list, and an open page updates them as the hook reports.

import type { Card, Decision, MirrorView, RouteKind } from "../shared/types";
import { type Child, h } from "./dom";
import { GLYPH, SOURCE_LABEL } from "./derive";
import { hrefFor } from "./router";
import { S, isCard } from "./state";

/** Every mirror the page knows, by ticket id, as the server last reported it. */
export const MIRRORS = new Map<string, MirrorView>();

export function setMirrors(m: Record<string, MirrorView> | undefined): void {
  MIRRORS.clear();
  for (const [id, v] of Object.entries(m ?? {})) MIRRORS.set(id, v);
}

export const isMirror = (id: string) => MIRRORS.has(id);

/** What Bug Me would have done, in a few words. */
function shadowLine(m: MirrorView): string {
  if (!m.routed || !m.shadow) return "Bug Me is still reading this one.";
  const s = m.shadow;
  const would: Record<RouteKind, string> = {
    settle: `Bug Me would have settled it${s.label ? `: “${s.label}”` : ""}.`,
    check_in: "Bug Me would bring it as a quick check.",
    decide: "Bug Me would bring it to you.",
  };
  return would[s.route];
}

const shadowGlyph = (m: MirrorView): string => (m.routed && m.shadow ? GLYPH[m.shadow.route] : "…");

/** How it stands, in a few words: the line the card and the list share. */
export function mirrorStatus(m: MirrorView): string {
  if (m.state === "pending") return "Answer it in the session";
  if (m.state === "answered") return `Answered in the session: ${m.answer?.text || "(blank)"}`;
  return `Closed: ${m.closed_why ?? "no answer seen"}`;
}

/** The read-only card for a mirrored question. */
export function renderMirror(root: HTMLElement, d: Decision, m: MirrorView): void {
  const c = S.cards[d.id] as Card | undefined;
  const card = isCard(c) ? c : undefined;
  const picked = new Set(m.answer?.keys ?? []);
  const which = m.kind === "plan" ? "Plan approval" : `${m.header ? `${m.header} · ` : ""}${m.of > 1 ? `question ${m.index + 1} of ${m.of}` : "question"}${m.multi ? " · pick any" : ""}`;
  const options = h(
    "ul",
    { class: "options mirror-opts", "aria-label": "Its options" },
    ...d.options.map((o) =>
      h(
        "li",
        { class: `opt mirror-opt${picked.has(o.key) ? " picked" : ""}` },
        h("span", { class: "key", "aria-hidden": "true" }, o.key),
        h("b", { class: "opt-label" }, o.label),
        o.description ? h("span", { class: "opt-desc" }, o.description) : null,
        picked.has(o.key) ? h("span", { class: "sr-only" }, " (picked in the session)") : null,
      ),
    ),
  );
  const body: Child[] = [
    h("div", { class: "meta" }, h("span", { class: "glyph", "aria-hidden": "true" }, shadowGlyph(m)), h("span", { class: "route-label" }, "From your terminal"), h("span", { class: "chain" }, `${d.agent.join(" › ")} · ${which}`)),
    card?.briefing || card?.in_your_terms ? h("p", { class: "briefing" }, card.briefing || card.in_your_terms) : null,
    h("p", { class: "why" }, shadowLine(m)),
    h("h3", { id: "now-q" }, card?.headline || d.question),
    card?.headline && card.headline !== d.question ? h("p", { class: "original" }, h("span", { class: "quiet" }, "The session asked: "), h("q", {}, d.question)) : null,
    options,
    h("p", { class: `mirror-status ${m.state}`, role: "status" }, h("span", { "aria-hidden": "true" }, m.state === "pending" ? "›_ " : m.state === "answered" ? "✓ " : "– "), mirrorStatus(m)),
    card && m.routed ? h("p", { class: "quiet small" }, `Briefing: ${SOURCE_LABEL[card.source]}. Mirror only: Bug Me records what it would have done and acts on nothing.`) : null,
  ];
  root.append(h("article", { class: "card steady mirror", "data-state": m.state, "aria-labelledby": "now-q" }, ...body));
}

/** Home's list of mirrored questions: waiting first, then how the rest ended. Null when there are none. */
export function mirrorList(byId: Map<string, Decision>): HTMLElement | null {
  const ids = [...MIRRORS.keys()].filter((id) => byId.has(id));
  if (!ids.length) return null;
  const rank = (id: string) => (MIRRORS.get(id)!.state === "pending" ? 0 : 1);
  ids.sort((a, b) => rank(a) - rank(b));
  const headline = (id: string) => {
    const c = S.cards[id];
    return (isCard(c) && c.headline) || byId.get(id)!.question;
  };
  return h(
    "section",
    { class: "list-block", id: "mirrors", "aria-labelledby": "mirrors-h" },
    h("h2", { class: "section-h", id: "mirrors-h" }, "In your sessions"),
    h(
      "ol",
      { class: "items" },
      ...ids.map((id) => {
        const m = MIRRORS.get(id)!;
        return h(
          "li",
          { "data-id": id, "data-state": m.state },
          h(
            "a",
            { href: hrefFor({ view: "focus", id }), class: `item${m.state === "pending" ? "" : " ended"}` },
            h("span", { class: "glyph", "aria-hidden": "true" }, shadowGlyph(m)),
            h("span", { class: "q" }, headline(id)),
            h("span", { class: "mirror-note" }, mirrorStatus(m)),
          ),
        );
      }),
    ),
  );
}
