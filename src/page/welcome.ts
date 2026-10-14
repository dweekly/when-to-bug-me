// Onboarding (docs/STAGE-10.md): how Bug Me gets to know a person before it routes anything. It reads
// their recent decisions, drafts a "how to work with me" note whose every line cites the decisions behind
// it, interviews them about what it saw, and revises the note. On the public site this is Jordan, on
// recorded Claude runs; the morning keeps running on Jordan's hand-written note. On the runner's /me it
// is the owner's own history (10b): imported with `npm run onboard`, and kept as facts and their note.

import historyJson from "../../fixtures/history.json";
import { type HistoryItem, type InterviewQuestion, MAX_ANSWER_CHARS, type NoteLine, type OnboardingRun, type RevisedLine, parseHistory } from "../shared/onboarding";
import { ONBOARDING_ANSWERS } from "../shared/onboardingScript";
import type { Source } from "../shared/types";
import { api } from "./api";
import { SOURCE_LABEL } from "./derive";
import { $, announce, h } from "./dom";
import { hrefFor } from "./router";
import { Q, S, save } from "./state";
import { reroute } from "./actions";
import { waitingIds } from "./derive";
import { tourAfterRender } from "./tour";
import { drainVoice, setVoiceTarget } from "./voice";

const jordan: HistoryItem[] = parseHistory(historyJson.decisions);
/** The history on screen: Jordan's, or on /me the owner's run. */
let history: HistoryItem[] = jordan;
let byId = new Map(history.map((x) => [x.id, x]));
/** On /me: the owner's run, once loaded ("none" when there isn't one yet). */
let run: OnboardingRun | "none" | null = null;
let kept = 0;
const who = () => (Q.owner ? "you" : Q.persona.first_name);
/** The run on the page: every owner step names it, so a newer import can't be acted on unseen. */
const runId = () => (run && run !== "none" ? run.id : "");
const kept_ = () => Boolean(run && run !== "none" && run.kept_at);

/** The version of the run this page shows: a step from an older one is refused (another tab moved it on). */
const runRev = () => (run && run !== "none" ? (run.rev ?? 0) : 0);

function useRun(r: OnboardingRun | null): void {
  run = r ?? "none";
  if (!r) return;
  history = r.history;
  byId = new Map(history.map((x) => [x.id, x]));
  Object.assign(w, { note: r.note, noteSource: r.sources?.note ?? null, questions: r.questions ?? null, questionsSource: r.questions ? (r.sources?.questions ?? null) : null, answers: { ...(r.answers ?? {}) }, submitted: { ...(r.answers ?? {}) }, revised: r.revised ?? null, revisedSource: r.revised ? (r.sources?.revised ?? null) : null });
}

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
  busy: "" as "" | "draft" | "interview" | "revise" | "keep",
  error: "",
  /** Note lines whose cited decisions are showing. */
  open: new Set<string>(),
};

const KIND_ICON: Record<NoteLine["kind"], [string, string]> = {
  preference: ["◇", "How they like to be asked"],
  "rule-like": ["◆", "A call made the same way every time"],
  contradiction: ["⇄", "Decisions that point two ways"],
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

async function step(kind: "draft" | "interview" | "revise" | "keep"): Promise<void> {
  // One step at a time: a second press while one is out would race it (and, live, pay twice).
  if (w.busy) return;
  if (kind === "revise" && !canRevise().ok) return;
  const g = generation;
  w.busy = kind;
  w.error = "";
  w.open.clear();
  paint();
  try {
    if (Q.owner) {
      if (kind === "keep") {
        const r = await api<{ added: number; run: OnboardingRun }>("/api/me/onboarding/keep", { run: runId(), rev: runRev() });
        kept = r.added;
        useRun(r.run);
        // The kept lines are facts and the note now: take the server's copy of both, and check the waiting
        // decisions again under them, as for any change of guidance.
        const q = await api<{ facts: typeof S.facts; persona: typeof Q.persona }>("/api/queue");
        S.facts = q.facts;
        Q.persona = q.persona;
        S.version++;
        save();
        void reroute(waitingIds(), "because you kept your onboarding note");
      } else if (kind !== "draft") {
        if (kind === "revise") await drainVoice();
        const sent = { ...w.answers };
        const r = await api<{ run: OnboardingRun }>(`/api/me/onboarding/${kind}`, kind === "revise" ? { run: runId(), rev: runRev(), answers: sent } : { run: runId(), rev: runRev() });
        if (kind === "revise" && JSON.stringify(w.answers) !== JSON.stringify(sent)) throw new Error("you changed an answer while Bug Me revised; press Revise again");
        useRun(r.run);
      }
    } else if (kind === "draft") {
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
      // An answer edited while Bug Me revised didn't make this note: leave the answers open to send again.
      if (JSON.stringify(w.answers) !== JSON.stringify(sent)) throw new Error("you changed an answer while Bug Me revised; press Revise again");
      Object.assign(w, { revised: r.lines, revisedSource: r.source, submitted: sent });
    }
    announce(kind === "draft" ? "Note drafted." : kind === "interview" ? "Questions ready." : kind === "keep" ? "Kept." : "Note revised.");
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
    chip("▤", `${history.length} decisions · ${span} days`, Q.owner ? "Your recent decisions, from allowed projects" : "Jordan's recent decisions (synthetic)"),
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
            { class: "note-why", title: because ? `${Q.owner ? "You" : "Jordan"}: “${w.submitted[because.id] ?? ""}”` : "" },
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
      const ta = h("textarea", { id: `answer-${q.id}`, rows: "1", "aria-label": `Your answer to: ${q.text}`, placeholder: "Say it or type it…", readonly: locked, maxlength: String(MAX_ANSWER_CHARS) }) as HTMLTextAreaElement;
      ta.value = w.answers[q.id] ?? "";
      // The box grows with what's in it, so a spoken answer is read whole.
      const fit = () => {
        ta.style.height = "auto";
        ta.style.height = `${ta.scrollHeight}px`;
      };
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
  if (Q.owner && run === null) {
    view.replaceChildren(h("section", { class: "page welcome" }, h("h1", {}, "Getting to know you"), h("p", { class: "quiet" }, "Loading…")));
    void api<{ run: OnboardingRun | null }>("/api/me/onboarding").then(
      (r) => (useRun(r.run), paint()),
      (e) => ((run = "none"), (w.error = (e as Error).message), paint()),
    );
    return;
  }
  if (Q.owner && run === "none") {
    view.replaceChildren(
      h(
        "section",
        { class: "page welcome" },
        h("h1", {}, "Getting to know you"),
        h("p", { class: "quiet" }, "Bug Me drafts your note from your own decisions, on the runner, with your Claude login. On this Mac:"),
        h("pre", { class: "onboard-cmd" }, h("code", {}, "npm run onboard -- --allow <allow-list.json> <rows.jsonl>")),
        h("p", { class: "quiet small" }, "Rows extracted from your transcripts; only projects on your allow list are read."),
        w.error ? h("p", { class: "think-msg", role: "alert" }, w.error) : null,
      ),
    );
    return;
  }
  const lines = w.revised?.filter((l) => l.change !== "removed") ?? null;
  view.replaceChildren(
    h(
      "section",
      { class: "page welcome" },
      h("h1", {}, Q.owner ? "Getting to know you" : "Getting to know Jordan"),
      h("p", { class: "quiet" }, Q.owner ? "From your own decisions, drafted on this Mac with your Claude login." : "Before it routes anything, Bug Me learns how Jordan decides."),
      h(
        "ol",
        { class: "welcome-steps" },
        h(
          "li",
          { id: "step-read" },
          h("h2", {}, "Read"),
          stats(),
          w.note || Q.owner ? null : h("button", { type: "button", class: "primary", id: "draft-note", disabled: Boolean(w.busy), onclick: () => void step("draft") }, busyLabel("draft", "Draft the note", "Reading…")),
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
              w.questions ? null : h("button", { type: "button", class: "primary", id: "start-interview", disabled: Boolean(w.busy), onclick: () => void step("interview") }, busyLabel("interview", Q.owner ? "Interview me" : "Interview Jordan", "Thinking…")),
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
                ? kept_()
                  ? null
                  : h("button", { type: "button", class: "ghost small", id: "change-answers", onclick: () => ((w.revised = null), (w.submitted = {}), paint()) }, "Change answers")
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
              h("h2", {}, Q.owner ? "Your drafted note" : "Jordan's drafted note"),
              h("ol", { class: "wnote revised" }, ...w.revised.map((l) => noteLine(l, true))),
              source(w.revisedSource),
              Q.owner
                ? run && run !== "none" && run.kept_at
                  ? h("p", { class: "quiet small" }, `Kept${kept ? `: ${kept} new facts` : ""}. It's your note now; edit any line in `, h("a", { href: hrefFor({ view: "rules" }) }, "Rules"), ".")
                  : h("button", { type: "button", class: "primary", id: "keep-note", disabled: Boolean(w.busy), onclick: () => void step("keep") }, busyLabel("keep", "Keep it", "Keeping…"))
                : h(
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
  // Size the answer boxes to what's in them now that they're on the page (a box measures nothing detached).
  for (const ta of view.querySelectorAll<HTMLTextAreaElement>(".interview textarea")) {
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }
}
