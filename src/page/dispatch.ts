// Dispatch (docs/STAGE-8.md): say what you want done; Bug Me sizes it and sets it up. The brief is
// drafted by the Worker; this view shows it, lets the person adjust the setup (model, effort, mode,
// time, money, tools), keeps Copy command off until every prerequisite is ticked, and shows what the
// session reported. On the public site briefs live in this browser and the command is illustration
// only; on /me they live in the owner's queue, and Copy starts the clock. On the runner
// (docs/STAGE-9.md) Launch starts the session itself, and the brief shows how it's going.

import {
  BUGME_PREFIX,
  type Brief,
  type Catalog,
  DISPATCH_MODELS,
  EFFORTS,
  PERMISSION_MODES,
  TRIPWIRE_MULTIPLE,
  briefText,
  buildCommand,
  duration,
  money,
  sizeLine,
  tripwireMinutes,
} from "../shared/dispatch";
import { OWNER_POLL_MS } from "../shared/constants";
import { DISPATCH_EXAMPLES } from "../shared/dispatchExamples";
import type { Source } from "../shared/types";
import { api } from "./api";
import { SOURCE_LABEL } from "./derive";
import { $, announce, h } from "./dom";
import { go, hrefFor } from "./router";
import { Q, S } from "./state";
import { tourAfterRender } from "./tour";
import { drainVoice, setVoiceTarget } from "./voice";

/** Where the public site keeps its briefs: this browser only, separate from the morning. */
const PUBLIC_KEY = "bugme.dispatch.v1";

/** A brief as this page shows it: where its draft came from, and (public only) a synthetic report. */
type Shown = Brief & { source?: Source; synthetic_report?: { minutes: number; asks: number } };

let briefs: Shown[] | null = null;
let catalog: Catalog = { servers: [], skills: [] };
let loadError = "";
let openId: string | undefined;
/** The task box's text, the request in flight ("new", or the id of the brief being redrafted) and its
 *  error, kept outside the DOM so a re-render never wipes them. */
const draft = { task: "", busy: "", error: "" };
/** Answers to a brief's questions, per brief. */
const answers = new Map<string, string>();
/** Per brief, the setup fields whose typed value isn't valid: Copy waits until they are. */
const invalid = new Map<string, Set<string>>();
/** Briefs whose Details are open. */
const openDetails = new Set<string>();
/** The setup fields a person can change before a brief goes out. */
type SetupEdit = Partial<Pick<Brief, "model" | "effort" | "permission_mode" | "estimate_minutes" | "budget_usd" | "tools_off">>;
/**
 * On /me, setup edits not saved yet, per brief, laid over the brief as the server last sent it
 * (docs/STAGE-9.md). A refresh replaces the server's copy freely; these stay until a save succeeds. On the
 * public site there is no server copy, so edits go onto the brief itself.
 */
const unsaved = new Map<string, SetupEdit>();
const stored = (id: string) => briefs?.find((b) => b.id === id);
/** The brief as the page should show and send it: the server's copy with any unsaved edits on top. */
function current(id: string): Shown | undefined {
  const b = stored(id);
  return b && { ...b, ...unsaved.get(id) };
}
function edit(id: string, patch: SetupEdit): void {
  if (!Q.owner) {
    const b = stored(id);
    if (b) Object.assign(b, patch);
    savePublic();
  } else unsaved.set(id, { ...unsaved.get(id), ...patch });
}
/** Prerequisites ticked, per brief, in this page only. */
const ticked = new Map<string, Set<number>>();
let actionMsg = "";

/** A background session as the runner reports it (`claude agents --json --all`). */
interface RunnerSession {
  id: string;
  name: string;
  status?: string;
  state?: string;
  waitingFor?: string;
}
/** On the runner: the repos Launch can use and the sessions it started. Null anywhere else. */
let runner: { repos: { name: string; trusted: boolean }[]; sessions: RunnerSession[] | null; note: string } | null = null;
/** Asks waiting on the owner, per brief. */
let waiting: Record<string, string[]> = {};
const REPO_KEY = "bugme.runner.repo";
let repo = (() => {
  try {
    return localStorage.getItem(REPO_KEY) ?? "";
  } catch {
    return "";
  }
})();
let launching = "";
let polling = false;

const onDispatch = () => location.hash.startsWith("#/dispatch");

function loadPublic(): Shown[] {
  try {
    const v = JSON.parse(localStorage.getItem(PUBLIC_KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function savePublic(): void {
  if (Q.owner || !briefs) return;
  try {
    localStorage.setItem(PUBLIC_KEY, JSON.stringify(briefs));
  } catch {
    /* storage blocked: the briefs last as long as the page */
  }
}

/** The owner's briefs and catalog, from the server. (The public site's are read synchronously below.) */
async function load(): Promise<void> {
  const r = await api<{ briefs: Brief[]; catalog: Catalog; waiting?: Record<string, string[]> }>("/api/me/briefs");
  briefs = r.briefs;
  catalog = r.catalog;
  waiting = r.waiting ?? {};
  for (const b of r.briefs) if (b.ticked && !ticked.has(b.id)) ticked.set(b.id, new Set(b.ticked));
  // Only the runner answers this; the hosted Worker has no /runner/ routes.
  try {
    const st = await api<{ repos: { name: string; trusted: boolean }[]; sessions: RunnerSession[] | null; catalog_note: string }>("/runner/status");
    runner = { repos: st.repos, sessions: st.sessions, note: st.catalog_note };
  } catch {
    runner = null;
  }
  if (runner && !polling) {
    polling = true;
    setInterval(() => void poll(), OWNER_POLL_MS);
    document.addEventListener("visibilitychange", () => void poll());
  }
}

/** A change that arrived while something was being typed: drawn on the next quiet tick. */
let redrawPending = false;

/**
 * On the runner, while this view is visible: briefs, waiting asks, sessions and repos again. Unsaved
 * setup edits live apart from the server's copy, so nothing here can undo them. Redraws only when
 * something changed and nothing is being typed; a change held back for typing is drawn on the next
 * quiet tick.
 */
async function poll(): Promise<void> {
  if (document.visibilityState !== "visible" || !onDispatch() || launching) return;
  const snapshot = () => JSON.stringify([briefs, waiting, runner?.sessions, runner?.repos]);
  const before = snapshot();
  try {
    await load();
  } catch {
    return;
  }
  if (snapshot() !== before) redrawPending = true;
  if (!redrawPending || document.activeElement?.matches("#view input, #view textarea, #view select")) return;
  redrawPending = false;
  paint();
}

/** Redraw this view if it's still the one showing, and let a running tour find its target again. */
function paint(): void {
  if (!onDispatch()) return;
  renderDispatchView($("view"), openId);
  tourAfterRender();
}

export function renderDispatchView(view: HTMLElement, id?: string): void {
  if (id !== openId) actionMsg = "";
  openId = id;
  if (!briefs && !Q.owner) {
    briefs = loadPublic();
    catalog = Q.catalog ?? catalog;
  }
  if (!briefs) {
    view.replaceChildren(h("section", { class: "page dispatch" }, h("h1", {}, "Dispatch"), h("p", { class: "quiet" }, loadError || "Loading your briefs…")));
    if (!loadError) {
      void load().then(paint, (e) => {
        loadError = `Couldn't load your briefs: ${(e as Error).message}`;
        paint();
      });
    }
    return;
  }
  const open = briefs.find((b) => b.id === id) ?? null;
  view.replaceChildren(
    h(
      "section",
      { class: "page dispatch" },
      h("h1", {}, "Dispatch"),
      composer(),
      open ? conversation(open) : null,
      open ? briefCard(current(open.id)!) : null,
      briefs.length ? h("h2", { class: "section-h" }, "Briefs") : null,
      briefs.length ? h("ol", { class: "briefs" }, ...briefs.map((b) => briefRow(b, b.id === id))) : null,
    ),
  );
  for (const ta of view.querySelectorAll<HTMLTextAreaElement>(".think-field textarea")) fit(ta);
  // Speech goes to the answers box while Bug Me is asking, otherwise to the task box.
  const box = document.getElementById("dispatch-answers") ? "dispatch-answers" : "dispatch-task";
  setVoiceTarget({
    key: `dispatch:${box}:${id ?? ""}`,
    el: () => document.getElementById(box) as HTMLTextAreaElement | null,
    write: (t) => {
      if (box === "dispatch-answers" && id) answers.set(id, t);
      else draft.task = t;
    },
  });
}

function fit(ta: HTMLTextAreaElement): void {
  ta.style.height = "auto";
  ta.style.height = `${ta.scrollHeight}px`;
}

function textBox(id: string, label: string, placeholder: string, get: () => string, set: (v: string) => void): HTMLElement {
  const ta = h("textarea", { id, rows: "1", "aria-label": label, placeholder }) as HTMLTextAreaElement;
  ta.value = get();
  ta.addEventListener("input", () => {
    set(ta.value);
    fit(ta);
  });
  return h("div", { class: "think-field composer" }, ta);
}

function composer(): HTMLElement {
  const chips = Q.owner
    ? null
    : h(
        "div",
        { class: "demo-chips" },
        ...DISPATCH_EXAMPLES.map((x) =>
          h(
            "button",
            {
              type: "button",
              class: "demo-chip",
              "data-example": x.id,
              onclick: () => {
                draft.task = x.task;
                paint();
              },
            },
            x.label,
          ),
        ),
      );
  return h(
    "div",
    { class: "dispatch-new" },
    textBox("dispatch-task", "What do you want done?", "What do you want done?", () => draft.task, (v) => (draft.task = v)),
    chips,
    Q.owner ? h("p", { class: "quiet small" }, "Describe the task, not the sensitive data: drafting is a cloud call.") : null,
    h(
      "div",
      { class: "think-actions" },
      h("p", { class: "think-msg", role: "status" }, draft.error),
      h("button", { type: "button", class: "primary", id: "draft-brief", disabled: Boolean(draft.busy), onclick: () => void draftBrief() }, draft.busy === "new" ? "Sizing it…" : "Draft brief"),
    ),
  );
}

async function draftBrief(redraft?: Shown): Promise<void> {
  if (draft.busy) return;
  draft.busy = redraft?.id ?? "new";
  draft.error = "";
  paint();
  // A phrase still being heard belongs to this request: let it land before reading the box.
  await drainVoice();
  const task = redraft ? redraft.task : draft.task.trim();
  const said = redraft ? (answers.get(redraft.id) ?? "").trim() : "";
  const problem = !task ? "Say or type what the session should do." : redraft && !said ? "Answer one of the questions first." : "";
  if (problem) {
    draft.busy = "";
    draft.error = problem;
    return paint();
  }
  try {
    // Every answer so far goes along, so a second round of questions doesn't lose the first round's answers.
    const all = [redraft?.answers, said].filter(Boolean).join("\n\n");
    const r = await api<{ brief: Brief; source: Source }>("/api/dispatch", { task, ...(all ? { answers: all } : {}), rules: S.rules, facts: S.facts });
    const b: Shown = { ...r.brief, source: r.source };
    // A redrafted public brief replaces the one it answered; the owner's queue keeps both.
    briefs = [b, ...briefs!.filter((x) => Q.owner || x.id !== redraft?.id)];
    // Clear only what was sent: words typed or spoken while it was drafting stay.
    if (!redraft && draft.task.trim() === task) draft.task = "";
    if (redraft && (answers.get(redraft.id) ?? "").trim() === said) answers.delete(redraft.id);
    savePublic();
    draft.busy = "";
    go({ view: "dispatch", id: b.id });
    announce(`Brief drafted: ${b.headline}.`);
  } catch (e) {
    const err = e as Error & { unavailable?: boolean };
    draft.error = err.unavailable ? `Bug Me couldn't draft this one (${err.message}).${Q.owner ? "" : " The three demo tasks work without live calls."}` : `Couldn't draft it: ${err.message}`;
    draft.busy = "";
    paint();
  }
}

const face = () => h("img", { class: "bug-face", src: "/firefly/clay/attentive.png", alt: "", width: 28, height: 28 });

/**
 * What was said before the brief: the task, any answers so far, and Bug Me's questions with the box to
 * answer them. The brief under it is Bug Me's best reading until they're answered.
 */
function conversation(b: Shown): HTMLElement | null {
  if (!b.questions.length && !b.answers) return null;
  return h(
    "section",
    { class: "think thread dispatch-thread", "aria-label": "Talking the task through" },
    h(
      "ol",
      { class: "turns" },
      h("li", { class: "turn mine" }, h("p", {}, b.task)),
      b.answers ? h("li", { class: "turn mine" }, h("p", {}, b.answers)) : null,
      b.questions.length
        ? h("li", { class: "turn bug" }, face(), h("ol", { class: "turn-qs" }, ...b.questions.map((q) => h("li", {}, q))))
        : null,
    ),
    b.questions.length ? textBox("dispatch-answers", "Your answers", "Answer any of them…", () => answers.get(b.id) ?? "", (v) => answers.set(b.id, v)) : null,
    b.questions.length
      ? h(
          "div",
          { class: "think-actions" },
          h("button", { type: "button", class: "primary", id: "redraft", disabled: Boolean(draft.busy), onclick: () => void draftBrief(b) }, draft.busy === b.id ? "Resizing…" : "Send"),
        )
      : null,
  );
}

function briefRow(b: Shown, current: boolean): HTMLElement {
  const status = b.report
    ? b.report.outcome
    : waiting[b.id]?.length
      ? "waiting on you"
      : b.launch?.state === "failed"
        ? "launch failed"
        : b.launch
          ? "launched"
          : b.dispatched_at
            ? "copied"
            : "draft";
  return h(
    "li",
    { class: current ? "current" : "" },
    h("a", { href: hrefFor({ view: "dispatch", id: b.id }), "aria-current": current ? "true" : null }, b.headline),
    h("span", { class: "brief-row-meta" }, `${sizeLine(b)} · ${status}`),
  );
}

// ---------- One brief ----------

const nameOf = (prefix: string) => catalog.servers.find((s) => s.prefix === prefix)?.name ?? prefix.replace(/^mcp__/, "");

function select<T extends string>(label: string, value: T, options: readonly { v: T; t: string }[], onChange: (v: T) => void): HTMLElement {
  const s = h("select", { "aria-label": label }, ...options.map((o) => h("option", { value: o.v, selected: o.v === value }, o.t))) as HTMLSelectElement;
  s.addEventListener("change", () => onChange(s.value as T));
  return s;
}

/**
 * A setup number. A value outside the field's range (the same ranges the Worker accepts) is marked,
 * keeps the last good value in the brief, and holds Copy until it's fixed.
 */
function numberInput(b: Shown, field: string, label: string, value: number, step: string, ok: (v: number) => boolean, onChange: (v: number) => void): HTMLElement {
  const bad = invalid.get(b.id) ?? new Set<string>();
  invalid.set(b.id, bad);
  const i = h("input", { type: "number", min: "0", step, value: String(value), "aria-label": label, inputmode: "decimal", "aria-invalid": bad.has(field) ? "true" : "false" }) as HTMLInputElement;
  i.addEventListener("input", () => {
    const v = Number(i.value);
    const good = i.value.trim() !== "" && Number.isFinite(v) && ok(v);
    i.setAttribute("aria-invalid", good ? "false" : "true");
    if (good) {
      bad.delete(field);
      onChange(v);
    } else bad.add(field);
    refreshLive(b.id);
  });
  return i;
}

/** After an edit: the meta line, the tripwire and the command follow without redrawing the inputs. */
function refreshLive(id: string): void {
  const b = current(id);
  if (!b) return;
  const meta = document.querySelector("#brief .brief-meta");
  if (meta) meta.replaceWith(metaLine(b));
  const cmd = document.querySelector("#brief-cmd code");
  if (cmd) cmd.textContent = buildCommand(b, catalog);
  const { ready, message } = copyState(b);
  const copyCmd = document.getElementById("copy-command") as HTMLButtonElement | null;
  const copyBrief = document.getElementById("copy-brief") as HTMLButtonElement | null;
  if (copyCmd) copyCmd.disabled = !ready;
  const launchBtn = document.getElementById("launch") as HTMLButtonElement | null;
  if (launchBtn) launchBtn.disabled = !ready || !repo || launching === b.id;
  if (copyBrief) copyBrief.disabled = Boolean(invalid.get(b.id)?.size);
  const msg = document.querySelector("#brief .brief-actions .think-msg");
  if (msg) msg.textContent = actionMsg || message;
}

/** Whether Copy command may run, and if not, what's in the way. */
function copyState(b: Shown): { ready: boolean; message: string } {
  if (invalid.get(b.id)?.size) return { ready: false, message: "Fix the time or $ first." };
  const left = b.prerequisites.length - (ticked.get(b.id)?.size ?? 0);
  if (left > 0) return { ready: false, message: `Tick ${left} first.` };
  return { ready: true, message: "" };
}

const STAGE_ICON: Record<Brief["stage"], string> = { prototype: "◔", mvp: "◑", product: "●" };
const chip = (icon: string, text: string, title: string, cls = "") => h("span", { class: `meta-chip ${cls}`, title }, h("span", { class: "ico", "aria-hidden": "true" }, icon), text);

/** Stage, time with its stopping point, money, and where it runs: one line of chips. */
function metaLine(b: Shown): HTMLElement {
  return h(
    "p",
    { class: "brief-meta" },
    chip(STAGE_ICON[b.stage], b.stage === "mvp" ? "MVP" : b.stage, "Stage: build to this and no further"),
    chip("⏱", `${duration(b.estimate_minutes)} · asks at ${duration(tripwireMinutes(b))}`, `Estimate; the session stops to ask at ${TRIPWIRE_MULTIPLE}×`),
    chip("$", money(b.budget_usd).slice(1), "Model spend it's worth (a guide: a session can't see its spend)"),
    // On the runner every launch runs on this Mac; Claude still sees what it works on.
    runner ? chip(b.where === "local" ? "🔒" : "💻", "this Mac", b.where_reason || "Runs on this Mac", b.where === "local" ? "local" : "") : b.where === "local" ? chip("🔒", "local", b.where_reason, "local") : chip("☁", "cloud", "Runs in the cloud"),
  );
}

/** Model, effort, mode, time, money, tools, the rules it quotes, the source and the command. */
function details(b: Shown): HTMLElement {
  const setup = h(
    "div",
    { class: "brief-setup" },
    select("Model", b.model, DISPATCH_MODELS.map((m) => ({ v: m.id, t: m.label })), (v) => (edit(b.id, { model: v }), refreshLive(b.id))),
    select("Effort", b.effort, EFFORTS.map((e) => ({ v: e, t: `${e} effort` })), (v) => (edit(b.id, { effort: v }), refreshLive(b.id))),
    select("Permission mode", b.permission_mode, PERMISSION_MODES.map((m) => ({ v: m, t: m })), (v) => (edit(b.id, { permission_mode: v }), refreshLive(b.id))),
    h("label", {}, numberInput(b, "minutes", "Estimate in minutes", b.estimate_minutes, "5", (v) => v >= 1 && v <= 60 * 24 * 7, (v) => edit(b.id, { estimate_minutes: Math.round(v) })), " min"),
    h("label", {}, "$", numberInput(b, "dollars", "Budget in dollars", b.budget_usd, "0.5", (v) => v >= 0 && v <= 10_000, (v) => edit(b.id, { budget_usd: Math.round(v * 100) / 100 }))),
  );
  const offers = catalog.servers.filter((s) => s.prefix !== BUGME_PREFIX && !b.tools_off.includes(s.prefix) && !b.tools_needed.includes(s.prefix));
  const tools = h(
    "div",
    { class: "tool-chips" },
    ...b.tools_needed.map((p) => h("span", { class: "tool-chip on", title: "Needed" }, nameOf(p))),
    ...b.tools_off.map((p) =>
      h(
        "button",
        {
          type: "button",
          class: "tool-chip off",
          "aria-label": `${nameOf(p)} is off; turn it back on`,
          onclick: () => {
            edit(b.id, { tools_off: (current(b.id)?.tools_off ?? []).filter((x) => x !== p) });
            paint();
          },
        },
        nameOf(p),
      ),
    ),
    offers.length
      ? select("Turn off another tool", "", [{ v: "", t: "Turn off…" }, ...offers.map((s) => ({ v: s.prefix, t: s.name }))], (v) => {
          if (!v) return;
          edit(b.id, { tools_off: [...(current(b.id)?.tools_off ?? []), v] });
          paint();
        })
      : null,
  );
  // A redraw (a tool toggled) keeps Details open if it was.
  const more = h("details", { class: "brief-more", open: openDetails.has(b.id) });
  more.addEventListener("toggle", () => ((more as HTMLDetailsElement).open ? openDetails.add(b.id) : openDetails.delete(b.id)));
  const parts: (HTMLElement | null)[] = [
    h("summary", {}, "Details"),
    setup,
    b.where_reason ? h("p", { class: "quiet small" }, b.where_reason) : null,
    tools,
    b.skills.length ? h("p", { class: "quiet small" }, `Skills: ${b.skills.join(", ")}`) : null,
    ...b.guidance.map((g) => h("blockquote", {}, g)),
    h("pre", { id: "brief-cmd" }, h("code", {}, buildCommand(b, catalog))),
    // On the runner, Launch is the main way; the command is still here to run by hand.
    runner ? h("button", { type: "button", class: "ghost small", id: "copy-command", disabled: !copyState(b).ready, onclick: () => void copy(b.id, "command") }, "Copy command") : null,
    h("p", { class: "quiet small" }, [b.source ? SOURCE_LABEL[b.source] : "", Q.owner ? "" : "Illustration: Jordan's tools are made up."].filter(Boolean).join(" · ")),
  ];
  more.append(...parts.filter((x): x is HTMLElement => x !== null));
  return more;
}

function briefCard(b: Shown): HTMLElement {
  const ticks = ticked.get(b.id) ?? new Set<number>();
  ticked.set(b.id, ticks);
  const { ready, message } = copyState(b);
  const local = b.where === "local";

  const youFirst = b.prerequisites.length
    ? h(
        "section",
        { class: "brief-you", "aria-label": "You first" },
        h("h3", {}, "You first"),
        h(
          "ul",
          {},
          ...b.prerequisites.map((p, i) => {
            const box = h("input", { type: "checkbox", checked: ticks.has(i) }) as HTMLInputElement;
            box.addEventListener("change", () => {
              if (box.checked) ticks.add(i);
              else ticks.delete(i);
              paint();
            });
            return h("li", {}, h("div", { class: "you-row" }, h("label", { title: p.why }, box, h("span", {}, p.what)), howButton(b, i)), walkPanel(b, i));
          }),
        ),
      )
    : null;

  const copyCmd = h(
    "button",
    { type: "button", class: local ? "ghost" : "primary", id: "copy-command", disabled: !ready, onclick: () => void copy(b.id, "command") },
    local ? "Run in cloud anyway" : "Copy command",
  );
  const copyBrief = h("button", { type: "button", class: local ? "primary" : "ghost", id: "copy-brief", disabled: Boolean(invalid.get(b.id)?.size), onclick: () => void copy(b.id, "brief") }, "Copy brief");

  const actions = runner
    ? b.launch && b.launch.state !== "failed"
      ? sessionLine(b)
      : launchControls(b, ready, message)
    : h("div", { class: "think-actions brief-actions" }, h("p", { class: "think-msg", role: "status" }, actionMsg || message), copyBrief, copyCmd);

  return h(
    "article",
    { class: "brief", id: "brief", "aria-labelledby": "brief-h" },
    h("header", {}, h("h2", { id: "brief-h" }, b.headline), metaLine(b)),
    h("p", { class: "brief-goal" }, b.goal),
    b.done.length ? h("ul", { class: "brief-done", "aria-label": "Done when" }, ...b.done.map((x) => h("li", {}, x))) : null,
    b.out_of_scope.length ? h("p", { class: "brief-skip", title: "Not this time" }, h("span", { class: "ico", "aria-label": "Not this time" }, "⊘"), b.out_of_scope.join(" · ")) : null,
    youFirst,
    b.check_ins.length ? h("p", { class: "brief-asks", title: "Comes back to you" }, h("span", { class: "ico", "aria-label": "Asks you before" }, "↩"), b.check_ins.join(" · ")) : null,
    actions,
    details(b),
    report(b),
  );
}

/** "Walk me through it" (docs/STAGE-9.md): steps per item, fetched once and kept for the page's life. */
type Walk = { steps: { text: string; url?: string }[]; source: Source } | { error: string } | "loading";
const walks = new Map<string, Walk>();
const openWalks = new Set<string>();
const walkKey = (b: Shown, i: number) => `${b.id}:${i}:${b.prerequisites[i]?.what ?? ""}`;

function howButton(b: Shown, i: number): HTMLElement {
  const k = walkKey(b, i);
  const open = openWalks.has(k);
  return h(
    "button",
    {
      type: "button",
      class: "ghost small how",
      "aria-expanded": open ? "true" : "false",
      "aria-controls": `walk-${i}`,
      onclick: () => {
        if (open) openWalks.delete(k);
        else {
          openWalks.add(k);
          const w = walks.get(k);
          if (!w || (w !== "loading" && "error" in w)) void fetchWalk(b, i);
        }
        paint();
      },
    },
    "How?",
  );
}

async function fetchWalk(b: Shown, i: number): Promise<void> {
  const k = walkKey(b, i);
  walks.set(k, "loading");
  try {
    const p = b.prerequisites[i];
    const r = Q.owner
      ? await api<{ steps: { text: string; url?: string }[]; source: Source }>(`/api/me/briefs/${b.id}/walk`, { item: i })
      : await api<{ steps: { text: string; url?: string }[]; source: Source }>("/api/walk", { what: p.what, why: p.why, headline: b.headline, goal: b.goal, tools: b.tools_needed.map(nameOf).filter((n) => n !== "bugme") });
    walks.set(k, r);
  } catch (e) {
    walks.set(k, { error: (e as Error).message });
  }
  paint();
}

function walkPanel(b: Shown, i: number): HTMLElement | null {
  const k = walkKey(b, i);
  if (!openWalks.has(k)) return null;
  const w = walks.get(k);
  if (!w || w === "loading") return h("p", { class: "walk quiet small", id: `walk-${i}` }, "Working out the steps…");
  if ("error" in w) return h("p", { class: "walk quiet small", id: `walk-${i}` }, `Couldn't get the steps: ${w.error}`);
  return h(
    "div",
    { class: "walk", id: `walk-${i}` },
    h(
      "ol",
      {},
      ...w.steps.map((st) =>
        h("li", {}, st.text, st.url ? h("a", { href: st.url, target: "_blank", rel: "noopener noreferrer", class: "walk-link" }, `${new URL(st.url).hostname} ↗`) : null),
      ),
    ),
    h(
      "p",
      { class: "walk-foot" },
      runner ? h("button", { type: "button", class: "ghost small", id: `walk-with-${i}`, onclick: () => void doItWithMe(b, i) }, "Do it with me") : null,
      h("span", { class: "quiet small" }, SOURCE_LABEL[w.source]),
    ),
  );
}

/** Runner only: a Claude in Chrome session on the Mac that points the way and stops before any secret. */
async function doItWithMe(b: Shown, i: number): Promise<void> {
  try {
    await api("/runner/walk", { brief_id: b.id, item: i });
    actionMsg = "Opened a Terminal on the Mac: say you're ready there.";
  } catch (e) {
    actionMsg = (e as Error).message;
  }
  paint();
  announce(actionMsg);
}

const tickList = (b: Shown) => [...(ticked.get(b.id) ?? [])].sort((x, y) => x - y);

/** The repo picker and Launch (runner only). Untrusted repos are listed but can't be picked. */
function launchControls(b: Shown, ready: boolean, message: string): HTMLElement {
  const repos = runner!.repos;
  if (repo && !repos.some((r) => r.name === repo && r.trusted)) repo = "";
  const pick = h(
    "select",
    { id: "launch-repo", "aria-label": "Repo" },
    h("option", { value: "" }, "Repo…"),
    ...repos.map((r) => h("option", { value: r.name, selected: r.name === repo, disabled: !r.trusted, title: r.trusted ? "" : `Run claude in ${r.name} once to trust it` }, r.trusted ? r.name : `${r.name} (untrusted)`)),
  ) as HTMLSelectElement;
  const go = h("button", { type: "button", class: "primary", id: "launch", disabled: !ready || !repo || launching === b.id, onclick: () => void launch(b.id) }, launching === b.id ? "Launching…" : "Launch") as HTMLButtonElement;
  pick.addEventListener("change", () => {
    repo = pick.value;
    try {
      localStorage.setItem(REPO_KEY, repo);
    } catch {
      /* remembered for this page only */
    }
    go.disabled = !copyState(b).ready || !repo;
  });
  const failed = b.launch?.state === "failed" ? `Last launch failed: ${b.launch.error ?? "unknown"}.` : "";
  return h("div", { class: "think-actions brief-actions" }, h("p", { class: "think-msg", role: "status" }, actionMsg || message || failed), pick, go);
}

/** How a launched session is doing, in one line, with the command to open it. */
function sessionLine(b: Shown): HTMLElement {
  const name = `bugme-${b.id}-${b.launch!.attempt}`;
  const s = runner?.sessions?.find((x) => x.name === name);
  const asks = waiting[b.id] ?? [];
  const [icon, text, cls]: [string, string, string] =
    b.launch!.state === "launching"
      ? ["◌", "Starting…", ""]
      : asks.length
        ? ["↩", "Waiting on you", "warn"]
        : b.report
          ? ["✓", "Reported", "ok"]
          : !s
            ? ["?", runner?.sessions ? "Session not found" : "Can't see sessions", "warn"]
            : s.state === "blocked"
              ? ["✋", `Needs you in Claude${s.waitingFor ? ` · ${s.waitingFor}` : ""}`, "warn"]
              : s.state === "working"
                ? ["●", "Working", ""]
                : s.state === "done"
                  ? ["✓", "Finished · no report", "warn"]
                  : ["⏹", s.state === "failed" ? "Failed" : "Stopped", "warn"];
  const id = b.launch!.session_id;
  const attach = id ? `claude attach ${id}` : "";
  return h(
    "div",
    { class: `brief-session ${cls}`, role: "status" },
    h("span", { class: "ico", "aria-hidden": "true" }, icon),
    asks.length ? h("a", { href: `#/d/${asks[0]}` }, text) : h("span", {}, text),
    h("span", { class: "quiet small" }, b.launch!.repo),
    attach
      ? h(
          "button",
          {
            type: "button",
            class: "ghost small",
            id: "copy-attach",
            title: "Open this session in a terminal",
            onclick: () =>
              void navigator.clipboard.writeText(attach).then(
                () => announce("Copied."),
                () => announce(attach),
              ),
          },
          h("code", {}, attach),
        )
      : null,
  );
}

/** Save the setup and ticks (the clock starts), then ask the runner to start the session. */
async function launch(id: string): Promise<void> {
  const b = current(id);
  const keep = stored(id);
  // The button can be stale for a moment; what's typed now decides.
  if (!b || !keep || !copyState(b).ready || !repo || launching) return;
  launching = id;
  actionMsg = "";
  paint();
  try {
    const { model, effort, permission_mode, estimate_minutes, budget_usd, tools_off } = b;
    const saved = await api<{ brief: Brief }>(`/api/me/briefs/${id}/dispatched`, { model, effort, permission_mode, estimate_minutes, budget_usd, tools_off, ticked: tickList(b) });
    // Saved: the server's copy has these now, so they stop being unsaved edits, even if the launch fails.
    Object.assign(keep, saved.brief);
    unsaved.delete(id);
    const r = await api<{ launch: Brief["launch"] }>("/runner/launch", { brief_id: id, repo });
    keep.launch = r.launch;
    announce("Launched.");
    // The session list from before the launch doesn't have it yet.
    await load().catch(() => {});
  } catch (e) {
    actionMsg = (e as Error).message;
    announce(actionMsg);
  }
  launching = "";
  paint();
}

const OUTCOME_ICON: Record<string, string> = { done: "✓", "stopped at tripwire": "⏹", partial: "◐", abandoned: "✕" };

function report(b: Shown): HTMLElement | null {
  const r = b.report;
  if (!r) return null;
  const synthetic = b.synthetic_report;
  const since = synthetic ? synthetic.minutes : b.dispatched_at ? Math.max(0, Math.round((Date.parse(r.at) - Date.parse(b.dispatched_at)) / 60_000)) : null;
  const asks = synthetic ? synthetic.asks : (b.asks ?? 0);
  const facts = [
    since === null ? null : `${duration(since)} of ~${duration(b.estimate_minutes)}`,
    asks === 0 ? "no asks" : asks === 1 ? "asked once" : `asked ${asks}×`,
    r.cost_usd === undefined ? null : money(r.cost_usd),
    r.scope === "as briefed" ? null : `scope ${r.scope}`,
  ].filter(Boolean);
  return h(
    "section",
    { class: `brief-report ${r.outcome === "done" ? "ok" : "warn"}`, "aria-label": "How it went" },
    h(
      "p",
      { class: "brief-outcome" },
      h("span", { class: "ico", "aria-hidden": "true" }, OUTCOME_ICON[r.outcome] ?? "•"),
      `${r.outcome} · ${facts.join(" · ")}`,
      synthetic ? h("span", { class: "meta-chip", title: "In real use, the session sends this back when it finishes or stops." }, "synthetic") : null,
    ),
    h("p", { class: "quiet" }, r.summary),
  );
}

async function copy(id: string, what: "command" | "brief"): Promise<void> {
  const b = current(id);
  const keep = stored(id);
  if (!b || !keep) return;
  // The text is fixed at the click, from the fields as they are now.
  const text = what === "command" ? buildCommand(b, catalog) : briefText(b, catalog);
  actionMsg = "";
  try {
    if (Q.owner) {
      // On /me the fields as copied are what ran: store them, and start the clock, before the text is
      // released. The clipboard call itself stays inside the click (Safari refuses one made after an
      // await), with a promise that resolves once the save has landed.
      const { model, effort, permission_mode, estimate_minutes, budget_usd, tools_off } = b;
      const saved = api<{ brief: Brief }>(`/api/me/briefs/${b.id}/dispatched`, { model, effort, permission_mode, estimate_minutes, budget_usd, tools_off, ticked: tickList(b) });
      const wrote = typeof ClipboardItem !== "undefined"
        ? navigator.clipboard.write([new ClipboardItem({ "text/plain": saved.then(() => new Blob([text], { type: "text/plain" })) })])
        : saved.then(() => navigator.clipboard.writeText(text));
      // The saved fields are now the server's; edits made while this was out stay unsaved.
      const after = (await saved).brief;
      const sent = { model, effort, permission_mode, estimate_minutes, budget_usd, tools_off };
      Object.assign(keep, sent, { dispatched_at: after.dispatched_at, ticked: after.ticked });
      const left = Object.fromEntries(Object.entries(unsaved.get(id) ?? {}).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(sent[k as keyof typeof sent])));
      if (Object.keys(left).length) unsaved.set(id, left);
      else unsaved.delete(id);
      await wrote;
    } else await navigator.clipboard.writeText(text);
    actionMsg = "Copied.";
  } catch (e) {
    actionMsg = `Couldn't copy (${(e as Error).message}). It's under Details.`;
  }
  if (!Q.owner && what === "command" && !keep.report) {
    // The public demo shows what a session would send back, labeled synthetic.
    const ex = DISPATCH_EXAMPLES.find((x) => x.task === b.task)?.report;
    if (ex) {
      const { minutes, asks, ...rest } = ex;
      keep.dispatched_at = new Date().toISOString();
      keep.report = { ...rest, at: keep.dispatched_at };
      keep.synthetic_report = { minutes, asks };
    }
  }
  savePublic();
  paint();
  announce(actionMsg);
}
