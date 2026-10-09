// The Bug Me page. No framework: state lives in one object, render() redraws from it, and every
// piece of model text is inserted as text (never as HTML). The choices about when to push back, ask
// why, or propose guidance are made by src/shared/lifecycle.ts, not here.
//
// The page is split by job: state.ts (types, storage, the shared singletons), dom.ts, api.ts,
// derive.ts (agenda and routes), card.ts (the card in front of the person), views.ts (everything
// else on screen), actions.ts (what clicks do). This file only boots it.

import { api } from "./api";
import { stopVoiceUnlessFor } from "./card";
import { $, announce, h } from "./dom";
import { type Queue, Q, S, fresh, load, save, setById, setF, setQ, setS } from "./state";
import { render } from "./views";

async function boot(): Promise<void> {
  setQ(await api<Queue>("/api/queue"));
  setById(new Map(Q.decisions.map((d) => [d.id, d])));
  setS(load(Q));
  $("export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), persona: Q.persona.name, synthetic: true, rules: S.rules, facts: S.facts, record: S.record }, null, 2)], { type: "application/json" });
    const a = h("a", { href: URL.createObjectURL(blob), download: "bug-me-record.json" });
    a.click();
  });
  $("reset").addEventListener("click", () => {
    setS(fresh(Q));
    setF(null);
    stopVoiceUnlessFor("");
    save();
    render();
    announce("Started the morning over.");
  });
  render();
}

boot().catch((e) => {
  $("now").replaceChildren(h("div", { class: "card" }, h("h3", {}, "Bug Me couldn't load."), h("p", { class: "context" }, String((e as Error).message))));
});
