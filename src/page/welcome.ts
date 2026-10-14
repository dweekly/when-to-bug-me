// Onboarding (docs/STAGE-10.md): how Bug Me gets to know a person before it routes anything. It reads
// their recent decisions, drafts a "how to work with me" note whose every line cites the decisions behind
// it, interviews them about what it saw, and revises the note. On the public site this is Jordan, on
// recorded Claude runs; the morning keeps running on Jordan's hand-written note.

import historyJson from "../../fixtures/history.json";
import { type HistoryItem, type InterviewQuestion, type NoteLine, type RevisedLine, parseHistory } from "../shared/onboarding";
import { ONBOARDING_ANSWERS } from "../shared/onboardingScript";
import type { Source } from "../shared/types";
import { api } from "./api";
import { SOURCE_LABEL } from "./derive";
import { $, announce, h } from "./dom";
import { hrefFor } from "./router";
import { Q } from "./state";
import { tourAfterRender } from "./tour";
import { drainVoice, setVoiceTarget } from "./voice";

const history: HistoryItem[] = parseHistory(historyJson.decisions);
const byId = new Map(history.map((x) => [x.id, x]));

/** Where the person is in onboarding, kept outside the DOM so a redraw never loses it. */
const w = {
  note: null as NoteLine[] | null,
  noteSource: null as Source | null,
  questions: null as InterviewQuestion[] | null,
  questionsSource: null as Source | null,
  answers: {} as Record<string, string>,
  revised: null as RevisedLine[] | null,
  revisedSource: null as Source | null,
  /** The answers as sent with the revision: what each change's "why" quotes, whatever the boxes say now. */
  submitted: {} as Record<string, string>,
  busy: "" as "" | "draft" | "interview" | "revise",
  error: "",
  /** Note lines whose cited decisions are showing. */
  open: new Set<string>(),
};

const KIND_ICON: Record<NoteLine["kind"], [string, string]> = {
  preference: ["◇", "How Jordan likes to be asked"],
  "rule-like": ["◆", "A call Jordan makes the same way every time"],
  contradiction: ["⇄", "Jordan's decisions point two ways"],
};
const CHANGE_ICON: Record<RevisedLine["change"], [string, string]> = {
  kept: ["·", "kept"],
  changed: ["✎", "changed by an answer"],
  added: ["+", "added from an answer"],
  removed: ["−", "removed by an answer"],
};

/** Start over (a tour beginning): onboarding's state lives outside the morning's. */
/** Bumped by every reset: a reply to a request made before it is ignored, whatever it says. */
let generation = 0;

export function resetWelcome(): void {
  generation++;
  Object.assign(w, { note: null, noteSource: null, questions: null, questionsSource: null, answers: {}, revised: null, revisedSource: null, submitted: {}, busy: "", error: "" });
  w.open.clear();
}

/**
 * Whether Revise can run now. On a keyless server only the recorded path exists, so every question needs
 * Jordan's recorded answer; live (or on the stand-in model) any answer will do.
 */
function canRevise(): { ok: boolean; why: string } {
  if (w.busy || !w.questions) return { ok: false, why: "" };
  const answered = w.questions.filter((q) => (w.answers[q.id] ?? "").trim());
  if (!answered.length) return { ok: false, why: "" };
  if (!Q.owner && Q.mode === "recorded" && w.questions.some((q) => w.answers[q.id] !== ONBOARDING_ANSWERS[q.id])) {
    return { ok: false, why: "No live connection here: use Jordan's answers (DEMO REPLY) for all three." };
  }
  return { ok: true, why: "" };
}
function syncRevise(): void {
  const go = document.getElementById("revise-note") as HTMLButtonElement | null;
  const msg = document.getElementById("revise-why");
  const c = canRevise();
  if (go) go.disabled = !c.ok;
  if (msg) msg.textContent = c.why;
}

const onWelcome = () => location.hash.startsWith("#/welcome");
function paint(): void {
  if (!onWelcome()) return;
  renderWelcomeView($("view"));
  tourAfterRender();
}

async function step(kind: "draft" | "interview" | "revise"): Promise<void> {
  // One step at a time: a second press while one is out would race it (and, live, pay twice).
  if (w.busy) return;
  if (kind === "revise" && !canRevise().ok) return;
  const g = generation;
  w.busy = kind;
  w.error = "";
  w.open.clear();
  paint();
  try {
    if (kind === "draft") {
      const r = await api<{ note: NoteLine[]; source: Source }>("/api/onboarding/draft", {});
      if (g !== generation) return;
      Object.assign(w, { note: r.note, noteSource: r.source, questions: null, revised: null, answers: {} });
    } else if (kind === "interview") {
      const r = await api<{ questions: InterviewQuestion[]; source: Source }>("/api/onboarding/interview", { note: w.note });
      if (g !== generation) return;
      Object.assign(w, { questions: r.questions, questionsSource: r.source, revised: null, answers: {} });
    } else {
      await drainVoice();
      const sent = { ...w.answers };
      const r = await api<{ lines: RevisedLine[]; source: Source }>("/api/onboarding/revise", { note: w.note, questions: w.questions, answers: sent });
      if (g !== generation) return;
      Object.assign(w, { revised: r.lines, revisedSource: r.source, submitted: sent });
    }
    announce(kind === "draft" ? "Note drafted." : kind === "interview" ? "Three questions." : "Note revised.");
  } catch (e) {
    if (g !== generation) return;
    w.error = (e as Error).message;
  }
  w.busy = "";
  paint();
}

const pct = (n: number) => `${n}`;
function stats(): HTMLElement {
  const quick = history.filter((x) => (x.seconds ?? 99) <= 5).length;
  const worded = history.filter((x) => x.reason || x.typed).length;
  const against = history.filter((x) => x.recommended && x.answer !== x.recommended).length;
  const span = Math.max(...history.map((x) => x.days_ago));
  const chip = (icon: string, text: string, title: string) => h("span", { class: "meta-chip", title }, h("span", { class: "ico", "aria-hidden": "true" }, icon), text);
  return h(
    "p",
    { class: "brief-meta welcome-stats" },
    chip("▤", `${history.length} decisions · ${span} days`, "Jordan's recent decisions (synthetic)"),
    chip("⚡", `${pct(quick)} answered in ≤5 s`, "Answered almost without reading"),
    chip("✍", `${pct(worded)} with reasons`, "Jordan typed a reason or an answer of their own"),
    chip("↺", `${pct(against)} against the agent`, "Went against the agent's recommendation"),
  );
}

/** One cited decision, compact: the question, the answer, any words. */
function cited(id: string): HTMLElement | null {
  const x = byId.get(id);
  if (!x) return null;
  const answer = x.answer ? (x.options.find((o) => o.key === x.answer)?.label ?? x.answer) : `“${x.typed}”`;
  return h(
    "li",
    {},
    h("span", { class: "cite-q" }, x.question),
    h("span", { class: "cite-a" }, "→ ", answer, x.seconds !== undefined ? h("span", { class: "quiet" }, ` · ${x.seconds}s`) : null),
    x.reason ? h("span", { class: "cite-r" }, `“${x.reason}”`) : null,
  );
}

function noteLine(l: NoteLine | RevisedLine, revised = false): HTMLElement {
  const [icon, title] = KIND_ICON[l.kind];
  const open = w.open.has(l.id);
  const change = revised ? (l as RevisedLine) : null;
  const because = change?.because ? w.questions?.find((q) => q.id === change.because) : undefined;
  return h(
    "li",
    { class: `note-line ${change ? `change-${change.change}` : ""}` },
    h("span", { class: "ico", title, "aria-label": title }, icon),
    h(
      "div",
      {},
      h("p", { class: "note-text" }, l.text),
      change && change.change !== "kept"
        ? h(
            "p",
            { class: "note-why", title: because ? `Jordan: “${w.submitted[because.id] ?? ""}”` : "" },
            h("span", { class: "ico", "aria-hidden": "true" }, CHANGE_ICON[change.change][0]),
            change.why ?? CHANGE_ICON[change.change][1],
          )
        : null,
      l.cites.length
        ? h(
            "button",
            {
              type: "button",
              class: "ghost small cites",
              "aria-expanded": open ? "true" : "false",
              onclick: () => {
                if (open) w.open.delete(l.id);
                else w.open.add(l.id);
                paint();
              },
            },
            `from ${l.cites.length} decision${l.cites.length === 1 ? "" : "s"}`,
          )
        : null,
      open ? h("ol", { class: "cites-list" }, ...l.cites.map(cited).filter((x): x is HTMLElement => x !== null)) : null,
    ),
  );
}

function interview(qs: InterviewQuestion[]): HTMLElement {
  return h(
    "ol",
    { class: "interview" },
    ...qs.map((q) => {
      // Once the note is revised from them, the answers are locked; "Change answers" unlocks them and drops the revision.
      const locked = Boolean(w.revised);
      const ta = h("textarea", { id: `answer-${q.id}`, rows: "2", "aria-label": `Your answer to: ${q.text}`, placeholder: "Say it or type it…", readonly: locked }) as HTMLTextAreaElement;
      ta.value = w.answers[q.id] ?? "";
      // The box grows with what's in it, so a spoken answer is read whole.
      const fit = () => {
        ta.style.height = "auto";
        ta.style.height = `${ta.scrollHeight}px`;
      };
      requestAnimationFrame(fit);
      ta.addEventListener("input", () => {
        fit();
        w.answers[q.id] = ta.value;
        syncRevise();
      });
      // Speech goes only to an answer that can still change; a locked one takes none.
      ta.addEventListener("focus", () =>
        setVoiceTarget(locked ? null : { key: `welcome:${q.id}`, el: () => document.getElementById(`answer-${q.id}`) as HTMLTextAreaElement | null, write: (t) => (w.answers[q.id] = t) }),
      );
      // DEMO REPLY: Jordan's scripted answer to THIS question, by its id (recorded, so it replays for free).
      const script = Q.owner || locked ? undefined : ONBOARDING_ANSWERS[q.id];
      const demo = script
        ? h(
            "button",
            {
              type: "button",
              class: "demo-reply",
              title: "Fill in Jordan's recorded answer",
              onclick: () => {
                ta.value = script;
                w.answers[q.id] = script;
                fit();
                syncRevise();
              },
            },
            "DEMO REPLY",
          )
        : null;
      return h(
        "li",
        { class: "iq" },
        h("img", { class: "bug-face", src: "/firefly/clay/attentive.png", alt: "", width: 28, height: 28 }),
        h("div", {}, h("p", { class: "turn-q" }, q.text), h("div", { class: "think-field composer" }, ta, demo)),
      );
    }),
  );
}

const busyLabel = (k: typeof w.busy, idle: string, busy: string) => (w.busy === k ? busy : idle);
const source = (s: Source | null) => (s ? h("p", { class: "quiet small" }, SOURCE_LABEL[s]) : null);

export function renderWelcomeView(view: HTMLElement): void {
  const lines = w.revised?.filter((l) => l.change !== "removed") ?? null;
  view.replaceChildren(
    h(
      "section",
      { class: "page welcome" },
      h("h1", {}, "Getting to know Jordan"),
      h("p", { class: "quiet" }, "Before it routes anything, Bug Me learns how Jordan decides."),
      h(
        "ol",
        { class: "welcome-steps" },
        h(
          "li",
          { id: "step-read" },
          h("h2", {}, "Read"),
          stats(),
          w.note ? null : h("button", { type: "button", class: "primary", id: "draft-note", disabled: Boolean(w.busy), onclick: () => void step("draft") }, busyLabel("draft", "Draft the note", "Reading…")),
        ),
        w.note
          ? h(
              "li",
              { id: "step-draft" },
              h("h2", {}, "Draft"),
              w.revised
                ? h("details", { class: "draft-was" }, h("summary", {}, `The first draft, ${w.note.length} lines`), h("ol", { class: "wnote" }, ...w.note.map((l) => noteLine(l))))
                : h("ol", { class: "wnote" }, ...w.note.map((l) => noteLine(l))),
              source(w.noteSource),
              w.questions ? null : h("button", { type: "button", class: "primary", id: "start-interview", disabled: Boolean(w.busy), onclick: () => void step("interview") }, busyLabel("interview", "Interview Jordan", "Thinking…")),
            )
          : null,
        w.questions
          ? h(
              "li",
              { id: "step-interview" },
              h("h2", {}, "Interview"),
              interview(w.questions),
              source(w.questionsSource),
              w.revised
                ? h("button", { type: "button", class: "ghost small", id: "change-answers", onclick: () => ((w.revised = null), (w.submitted = {}), paint()) }, "Change answers")
                : h(
                    "div",
                    { class: "row" },
                    h("p", { class: "think-msg", id: "revise-why", role: "status" }, canRevise().why),
                    h("button", { type: "button", class: "primary", id: "revise-note", disabled: !canRevise().ok, onclick: () => void step("revise") }, busyLabel("revise", "Revise the note", "Revising…")),
                  ),
            )
          : null,
        w.revised && lines
          ? h(
              "li",
              { id: "step-note" },
              h("h2", {}, "Jordan's drafted note"),
              h("ol", { class: "wnote revised" }, ...w.revised.map((l) => noteLine(l, true))),
              source(w.revisedSource),
              h(
                "p",
                { class: "quiet small" },
                "The morning runs on Jordan's hand-written note (",
                h("a", { href: hrefFor({ view: "rules" }) }, "Rules"),
                "), so its recordings stay exact. Next, in a real release: a week of guessing before every answer, acting on none.",
              ),
            )
          : null,
      ),
      w.error ? h("p", { class: "think-msg", role: "alert" }, `Couldn't do that: ${w.error}`) : null,
    ),
  );
  if (!w.questions || w.revised) setVoiceTarget(null);
}
