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
import { type Queue, Q, S, STORE_KEY, fresh, load, save, setById, setF, setQ, setS } from "./state";
import { startTour } from "./tour";
import { render } from "./views";

async function boot(): Promise<void> {
  await signIn();
  setQ(await api<Queue>("/api/queue"));
  setS(load(Q));
  // On /me the server is the source of truth for the queue, rules and set-asides (docs/STAGE-7.md).
  if (Q.owner) startOwner(Q);
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
  // A tour link (/app?tour=<id>, as the explainer's cards use) starts that tour.
  const tour = new URLSearchParams(location.search).get("tour");
  // The tours script Jordan's decisions; the owner's live queue has none.
  if (tour && !Q.owner) {
    history.replaceState(null, "", location.pathname + location.hash);
    startTour(tour);
  }
}

boot().catch((e) => {
  $("view").replaceChildren(h("section", { class: "page" }, h("h1", {}, "Bug Me couldn't load."), h("p", {}, String((e as Error).message))));
});
