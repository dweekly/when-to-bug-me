// The Bug Me app (/app). No framework: state lives in one object, render() redraws the current view
// from it, and every piece of model text is inserted as text (never as HTML). The choices about when
// to push back, ask why, or propose guidance are made by src/shared/lifecycle.ts, not here.
//
// The page is split by job: state.ts (types, storage, the shared singletons), dom.ts, api.ts,
// derive.ts (agenda and routes), router.ts (which view, from the URL), views.ts (each screen),
// card.ts (the decision in focus), visuals.ts (decision briefings), sky.ts (home's star map),
// actions.ts (what clicks do). This file only boots it.

import { api } from "./api";
import { ownerDecisions, signIn, startOwner } from "./live";
import { initVoice, voiceOff } from "./voice";
import { $, announce, h } from "./dom";
import { go } from "./router";
import { type Queue, Q, S, STORE_KEY, byId, fresh, load, save, setById, setF, setQ, setS } from "./state";
import { OWNER_POLL_MS } from "../shared/constants";
import type { PuntKind } from "../shared/punt";
import { plainOptions } from "../shared/titles";
import { startTour } from "./tour";
import { MIRRORS, setMirrors } from "./mirror";
import { render } from "./views";

/** Each decision's options in the person's terms, from its card (docs/STAGE-6F.md): the page shows,
 *  and Bug Me says, these; the agent's own labels stay as `agent_label`, for More context. */
function inPlainTerms(q: Queue): Queue {
  const labels = new Map(q.cards.flatMap((c) => ("labels" in c && c.labels ? [[c.id, c.labels] as const] : [])));
  return {
    ...q,
    decisions: q.decisions.map((d) => plainOptions(d, labels.get(d.id))),
    ...(q.answered ? { answered: q.answered.map((r) => ({ ...r, decision: plainOptions(r.decision, (r.card as { labels?: Record<string, string> } | null)?.labels) })) } : {}),
  };
}

async function boot(): Promise<void> {
  await signIn();
  setQ(inPlainTerms(await api<Queue>("/api/queue")));
  setS(load(Q));
  // On /me the server is the source of truth for the queue, rules and set-asides (docs/STAGE-7.md).
  if (Q.owner) startOwner(Q);
  setMirrors(Q.mirrors);
  setById(new Map((Q.owner ? ownerDecisions(Q, S.answered) : Q.decisions).map((d) => [d.id, d])));
  initVoice();
  // The record view's buttons are redrawn with it, so their clicks are handled here, once.
  document.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement | null)?.closest("button");
    if (!t) return;
    if (t.id === "export") {
      const blob = new Blob(
        [JSON.stringify({ exported_at: new Date().toISOString(), persona: Q.persona.name, synthetic: Q.persona.synthetic, rules: S.rules, facts: S.facts, set_aside: S.punts, record: S.record }, null, 2)],
        { type: "application/json" },
      );
      h("a", { href: URL.createObjectURL(blob), download: "bug-me-record.json" }).click();
    } else if (t.id === "reset" && Q.owner) {
      // The owner's morning is the server's: starting over drops this browser's drafts and reloads it.
      localStorage.removeItem(STORE_KEY);
      location.reload();
    } else if (t.id === "reset") {
      setS(fresh(Q));
      setF(null);
      voiceOff();
      save();
      announce("Started the morning over.");
      go({ view: "home" });
    }
  });
  // "Skip to content" must not change the hash (the router would read it as Home): move focus instead.
  document.querySelector(".skip")?.addEventListener("click", (e) => {
    e.preventDefault();
    $("view").focus();
  });
  window.addEventListener("hashchange", () => {
    render();
    // Move focus to the new view's card or heading, so keyboard and screen-reader users land in it.
    const target = document.querySelector<HTMLElement>("#now, #view h1");
    if (target && !target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    target?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  });
  render();
  if (Q.owner) setInterval(() => void newAsks(), OWNER_POLL_MS);
  // A tour link (/app?tour=<id>, as the explainer's cards use) starts that tour.
  const tour = new URLSearchParams(location.search).get("tour");
  // The tours script Jordan's decisions; the owner's live queue has none.
  if (tour && !Q.owner) {
    history.replaceState(null, "", location.pathname + location.hash);
    startTour(tour);
  }
}

/**
 * New asks arriving while the owner's page is open (a launched session's, say: docs/STAGE-9.md) join
 * the queue without a reload. For ordinary decisions, only additions: a decision already on the page,
 * and any answer in progress on it, is never touched. Mirrored questions (docs/STAGE-10.md, 10d) are
 * reconciled too: their card when routing finishes, and their state when the session answers or moves
 * on. The view redraws only when nothing is being typed.
 */
/** An arrival that couldn't be drawn because something was being typed: drawn on the next quiet tick. */
let redrawPending = false;

async function newAsks(): Promise<void> {
  if (document.visibilityState !== "visible") return;
  let q: Queue;
  try {
    q = inPlainTerms(await api<Queue>("/api/queue"));
  } catch {
    return; // offline or signed out: the next tick tries again
  }
  const arrived = q.decisions.filter((d) => !byId.has(d.id));
  if (arrived.length) {
    const ids = new Set(arrived.map((d) => d.id));
    const cards = q.cards.filter((c) => ids.has(c.id));
    // A new ask can name a project this page hasn't seen; the agenda and the card need its definition.
    const known = new Set(Q.persona.projects.map((p) => p.id));
    Q.persona = { ...Q.persona, projects: [...Q.persona.projects, ...q.persona.projects.filter((p) => !known.has(p.id))] };
    Q.decisions = [...Q.decisions, ...arrived];
    Q.cards = [...Q.cards, ...cards];
    for (const c of cards) S.cards[c.id] = c;
    for (const d of arrived) byId.set(d.id, d);
    // Set aside on another device before this page saw it: it arrives set aside, with its reason.
    for (const a of q.aside ?? []) {
      if (ids.has(a.id)) S.punts[a.id] = { id: a.id, kind: a.kind as PuntKind, reason: a.reason, instruction: a.instruction, at: a.at };
    }
    redrawPending = true;
    announce(arrived.length === 1 ? "A new ask came in." : `${arrived.length} new asks came in.`);
  }
  // Mirrors already on the page: take the server's state and card. Nothing of the person's is on them.
  const mirrors = q.mirrors ?? {};
  for (const [id, m] of Object.entries(mirrors)) {
    if (!byId.has(id)) continue;
    const before = MIRRORS.get(id);
    if (before && JSON.stringify(before) === JSON.stringify(m)) continue;
    MIRRORS.set(id, m);
    const card = q.cards.find((c) => c.id === id);
    if (card) {
      S.cards[id] = card;
      Q.cards = [...Q.cards.filter((c) => c.id !== id), card];
    }
    redrawPending = true;
    if (before && before.state === "pending" && m.state !== "pending") announce(m.state === "answered" ? "A session question was answered there." : "A session question closed.");
  }
  // A mirror the server no longer lists (it ended more than a day ago) leaves the list.
  for (const id of [...MIRRORS.keys()]) {
    if (!(id in mirrors)) {
      MIRRORS.delete(id);
      Q.decisions = Q.decisions.filter((d) => d.id !== id);
      byId.delete(id);
      redrawPending = true;
    }
  }
  const typing = document.activeElement?.matches("input, textarea, select");
  if (redrawPending && !typing && !location.hash.startsWith("#/dispatch")) {
    redrawPending = false;
    render();
  }
}

boot().catch((e) => {
  $("view").replaceChildren(h("section", { class: "page" }, h("h1", {}, "Bug Me couldn't load."), h("p", {}, String((e as Error).message))));
});
