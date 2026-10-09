// Everything on the page except the card in front of the person: the header and firefly, the agenda,
// what Bug Me settled, and the editable rules and facts. render() redraws all of it from state.

import type { Mood } from "../shared/lifecycle";
import type { Card, RouteKind } from "../shared/types";
import { editRule, undo } from "./actions";
import { markButton, renderNow } from "./card";
import { ROUTE_LABEL, SOURCE_LABEL, agenda } from "./derive";
import { $, h } from "./dom";
import { F, Q, S, byId, isCard, setF, unfinished } from "./state";

/** A rule being edited, kept across re-renders so an async update never wipes the draft. */
let ruleDraft: { id: string; text: string; error: string; focus: boolean } | null = null;

export function renderAgenda(): void {
  const a = agenda();
  const root = $("agenda");
  root.replaceChildren();
  const current = F?.id ?? S.current;
  // Answered decisions whose follow-up is still open (a pushback, "why?", or proposed guidance) stay
  // one click away, so leaving one never loses the loop.
  const open = Object.keys(S.flows).filter((id) => id !== current && S.answered[id] && unfinished(id));
  if (open.length) {
    root.append(h("h3", { class: "section" }, "Waiting for you to finish"), h("p", { class: "section-reason" }, "You answered these; Bug Me is still waiting on a reason or on your call about the guidance."));
    const list = h("ol", {});
    for (const id of open) {
      const d = byId.get(id)!;
      const c = S.cards[id];
      const step = { pushback: "Bug Me pushed back", why: "Bug Me asked why", proposal: "Keep this guidance?", busy: "Working…" }[S.flows[id].phase as "pushback" | "why" | "proposal" | "busy"];
      list.append(
        h(
          "li",
          {},
          h(
            "button",
            { type: "button", class: "item changed", onclick: () => { S.current = id; setF(null); render(); $("now").focus(); } },
            h("span", { class: "dot check_in" }),
            h("span", {}, h("span", { class: "q" }, (isCard(c) && c.headline) || d.question), h("span", { class: "r" }, step)),
            h("span", { class: "r" }, "›"),
          ),
        ),
      );
    }
    root.append(list);
  }
  for (const s of a.sections) {
    const items = [...s.decisions, ...s.check_ins].filter((i) => i.id !== current);
    root.append(h("h3", { class: "section" }, s.heading), h("p", { class: "section-reason" }, s.section_reason));
    const list = h("ol", {});
    const add = (i: { id: string; route: RouteKind; order_reason: string }) => {
      const d = byId.get(i.id)!;
      const c = S.cards[i.id];
      list.append(
        h(
          "li",
          {},
          h(
            "button",
            {
              type: "button",
              class: `item${S.changes[i.id] ? " changed" : ""}${S.pending.includes(i.id) ? " pending" : ""}`,
              onclick: () => {
                S.current = i.id;
                setF(null);
                render();
                $("now").focus();
              },
            },
            h("span", { class: `dot ${i.route}`, title: ROUTE_LABEL[i.route] }),
            h(
              "span",
              {},
              h("span", { class: "q" }, (isCard(c) && c.headline) || d.question),
              h("span", { class: "r" }, `${ROUTE_LABEL[i.route]} · ${i.order_reason}`),
              S.changes[i.id] ? h("span", { class: "change-note" }, S.changes[i.id]) : null,
              S.pending.includes(i.id) ? h("span", { class: "change-note" }, "re-checking…") : null,
            ),
            h("span", { class: "r" }, "›"),
          ),
        ),
      );
    };
    s.decisions.filter((i) => i.id !== current).forEach(add);
    const quick = s.check_ins.filter((i) => i.id !== current);
    if (quick.length) list.append(h("li", { class: "batch-label" }, `Quick check-ins, batched (${quick.length})`));
    quick.forEach(add);
    if (items.length) root.append(list);
  }
  const answered = Object.keys(S.answered).length;
  if (answered) root.append(h("p", { class: "done-note" }, `${answered} answered this morning.`));
}

export function renderSettled(): void {
  const a = agenda();
  const root = $("settled");
  root.replaceChildren();
  const ids = a.settled.filter((id) => !S.reopened.includes(id));
  if (!ids.length) root.append(h("li", {}, "Nothing settled without you yet."));
  for (const id of ids) {
    const d = byId.get(id)!;
    const c = S.cards[id] as Card;
    const opt = d.options.find((o) => o.key === c.settle_option);
    root.append(
      h(
        "li",
        { class: S.changes[id] ? "changed" : "" },
        h("span", {}, (c.headline || d.question).replace(/\?$/, ""), ": "),
        h("span", { class: "picked" }, opt?.label ?? c.settle_option),
        h("span", { class: "why-s" }, `${c.why_here} · ${SOURCE_LABEL[c.source]}`),
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
}

export function renderRules(): void {
  const root = $("rules");
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

export function renderFacts(): void {
  const root = $("facts");
  root.replaceChildren();
  for (const f of S.facts) root.append(h("li", { class: S.newFacts.includes(f.id) ? "new" : "" }, f.text, h("span", { class: "src" }, f.source)));
  const note = $("note");
  note.replaceChildren(...Q.persona.how_to_work_with_me.map((t) => h("li", {}, t)));
  $("note-source").textContent = Q.persona.how_to_work_with_me_source;
}

export function renderHeader(): void {
  const a = agenda();
  const waiting = a.sections.reduce((n, s) => n + s.decisions.length + s.check_ins.length, 0);
  const settled = a.settled.filter((id) => !S.reopened.includes(id)).length;
  const total = Q.decisions.length;
  $("overnight").textContent =
    `Overnight your agents raised ${total} questions. Bug Me settled ${settled} itself; ${waiting} need you` +
    (a.sections[0] ? `, starting with ${a.sections[0].project.name.toLowerCase()} because answers there unblock the most agents.` : ".");
  const ff = $("firefly");
  ff.style.setProperty("--glow", S.glow.toFixed(2));
  ff.dataset.mood = waiting === 0 ? "resting" : S.mood;
  const reasons = S.record.filter((r) => r.kind === "answer" && r.basis).length;
  const moodText: Record<Mood, string> = {
    resting: "Nothing is waiting. The firefly is resting.",
    glowing: `Glowing: you've given ${reasons} real reason${reasons === 1 ? "" : "s"} this morning.`,
    neutral: reasons ? `${reasons} reason${reasons === 1 ? "" : "s"} given so far.` : "The glow grows with every real reason you give.",
    dim: "A little dimmer: that decision went through without a recorded reason.",
    sheepish: "Sheepish: Bug Me brought you something it should have handled.",
  };
  const status = moodText[waiting === 0 ? "resting" : S.mood];
  $("glow-status").textContent = status;
  ff.setAttribute("aria-label", `Bug Me's firefly. ${status}`);
  $("record-summary").textContent = `${S.record.filter((r) => r.kind === "answer").length} answers, ${S.record.filter((r) => r.kind === "mark").length} marks, ${S.record.length} events recorded. Kept in this browser only.`;
  const tryEl = $("try");
  tryEl.replaceChildren();
  if (!S.answered["onsite-flight"]) {
    tryEl.append(
      "To see the loop in one minute: ",
      h("button", { type: "button", onclick: () => { S.current = "onsite-flight"; setF(null); render(); $("now").focus(); } }, "answer the 6:05am flight question"),
      " the way you actually would, and say why.",
    );
  }
  $("mode-note").textContent =
    Q.mode === "fake"
      ? " This deployment runs on a deterministic code stand-in for Claude (no API key yet), so routing here is keyword matching, not judgment."
      : Q.mode === "recorded"
        ? " Live calls are off right now: you are seeing recorded Claude runs, and anything new can't be evaluated."
        : "";
}

export function render(): void {
  renderHeader();
  renderNow();
  renderAgenda();
  renderSettled();
  renderRules();
  renderFacts();
}

/** Replace the rule being edited (actions.ts saves or rejects a draft from outside this module). */
export function setRuleDraft(d: typeof ruleDraft): void {
  ruleDraft = d;
}
