// Dispatch (docs/STAGE-8.md): say what you want done; Bug Me sizes it and sets it up. The brief is
// drafted by the Worker; this view shows it, lets the person adjust the setup (model, effort, mode,
// time, money, tools), keeps Copy command off until every prerequisite is ticked, and shows what the
// session reported. On the public site briefs live in this browser and the command is illustration
// only; on /me they live in the owner's queue, and Copy starts the clock.

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
  sizeLine,
  tripwireMinutes,
} from "../shared/dispatch";
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
/** Prerequisites ticked, per brief, in this page only. */
const ticked = new Map<string, Set<number>>();
let actionMsg = "";

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
  const r = await api<{ briefs: Brief[]; catalog: Catalog }>("/api/me/briefs");
  briefs = r.briefs;
  catalog = r.catalog;
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
      h("p", { class: "quiet" }, "Say what you want done. Bug Me sizes it and sets it up before a session starts."),
      composer(),
      open ? conversation(open) : null,
      open ? briefCard(open) : null,
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
        h("span", { class: "quiet" }, "Try:"),
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
    textBox("dispatch-task", "What should a session do?", "What should a session do?", () => draft.task, (v) => (draft.task = v)),
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
        ? h("li", { class: "turn bug" }, face(), h("p", {}, "Before I size this:"), h("ol", { class: "turn-qs" }, ...b.questions.map((q) => h("li", {}, q))))
        : null,
    ),
    b.questions.length ? textBox("dispatch-answers", "Your answers", "Answer any of them…", () => answers.get(b.id) ?? "", (v) => answers.set(b.id, v)) : null,
    b.questions.length
      ? h(
          "div",
          { class: "think-actions" },
          h("p", { class: "think-msg quiet" }, "Until then, the brief below is my best reading."),
          h("button", { type: "button", class: "primary", id: "redraft", disabled: Boolean(draft.busy), onclick: () => void draftBrief(b) }, draft.busy === b.id ? "Resizing…" : "Send"),
        )
      : null,
  );
}

function briefRow(b: Shown, current: boolean): HTMLElement {
  const status = b.report ? b.report.outcome : b.dispatched_at ? "copied" : "draft";
  return h(
    "li",
    { class: current ? "current" : "" },
    h("a", { href: hrefFor({ view: "dispatch", id: b.id }), "aria-current": current ? "true" : null }, b.headline),
    h("span", { class: "brief-row-meta" }, `${sizeLine(b)} · ${status}`),
  );
}

// ---------- One brief ----------

const nameOf = (prefix: string) => catalog.servers.find((s) => s.prefix === prefix)?.name ?? prefix.replace(/^mcp__/, "");
const list = (xs: string[], cls = "") => h("ul", { class: `brief-list ${cls}` }, ...xs.map((x) => h("li", {}, x)));
const row = (label: string, ...body: (Node | string | null)[]) => [h("dt", {}, label), h("dd", {}, ...body)];

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
    refreshLive(b);
  });
  return i;
}

/** After an edit: the size line, the tripwire and the command follow without redrawing the inputs. */
function refreshLive(b: Shown): void {
  savePublic();
  const size = document.querySelector("#brief .brief-size");
  if (size) size.textContent = sizeLine(b);
  const trip = document.getElementById("tripwire");
  if (trip) trip.textContent = tripwireText(b);
  const cmd = document.querySelector("#brief-cmd code");
  if (cmd) cmd.textContent = buildCommand(b, catalog);
  const { ready, message } = copyState(b);
  const copyCmd = document.getElementById("copy-command") as HTMLButtonElement | null;
  const copyBrief = document.getElementById("copy-brief") as HTMLButtonElement | null;
  if (copyCmd) copyCmd.disabled = !ready;
  if (copyBrief) copyBrief.disabled = Boolean(invalid.get(b.id)?.size);
  const msg = document.querySelector("#brief .brief-actions .think-msg");
  if (msg) msg.textContent = actionMsg || message;
}

/** Whether Copy command may run, and if not, what's in the way. */
function copyState(b: Shown): { ready: boolean; message: string } {
  if (invalid.get(b.id)?.size) return { ready: false, message: "Fix the time or money first." };
  const left = b.prerequisites.length - (ticked.get(b.id)?.size ?? 0);
  if (left > 0) return { ready: false, message: `Tick ${left === 1 ? "the prerequisite" : `the ${left} prerequisites`} to copy the command.` };
  return { ready: true, message: "" };
}

const tripwireText = (b: Shown) => `Stops to ask at ${tripwireMinutes(b)} min (${TRIPWIRE_MULTIPLE}× the estimate). The dollars are a guide: a session can't see its own spend.`;

function briefCard(b: Shown): HTMLElement {
  const ticks = ticked.get(b.id) ?? new Set<number>();
  ticked.set(b.id, ticks);
  const { ready, message } = copyState(b);
  const local = b.where === "local";

  const runsOn = h(
    "div",
    { class: "brief-setup" },
    select("Model", b.model, DISPATCH_MODELS.map((m) => ({ v: m.id, t: m.label })), (v) => ((b.model = v), refreshLive(b))),
    select("Effort", b.effort, EFFORTS.map((e) => ({ v: e, t: `${e} effort` })), (v) => ((b.effort = v), refreshLive(b))),
    select("Permission mode", b.permission_mode, PERMISSION_MODES.map((m) => ({ v: m, t: m })), (v) => ((b.permission_mode = v), refreshLive(b))),
  );
  const where = local
    ? h("p", { class: "brief-where local" }, h("span", { class: "glyph", "aria-hidden": "true" }, "◐ "), "Run locally. ", h("span", { class: "quiet" }, b.where_reason))
    : h("p", { class: "brief-where quiet" }, b.where_reason || "Runs in the cloud.");

  const time = h(
    "div",
    { class: "brief-setup" },
    h("label", {}, numberInput(b, "minutes", "Estimate in minutes", b.estimate_minutes, "5", (v) => v >= 1 && v <= 60 * 24 * 7, (v) => (b.estimate_minutes = Math.round(v))), " min"),
    h("label", {}, "$", numberInput(b, "dollars", "Budget in dollars", b.budget_usd, "0.5", (v) => v >= 0 && v <= 10_000, (v) => (b.budget_usd = Math.round(v * 100) / 100))),
  );

  // Tools: the ones it needs, the ones turned off (each a toggle back on), and a list to turn more off.
  const offers = catalog.servers.filter((s) => s.prefix !== BUGME_PREFIX && !b.tools_off.includes(s.prefix) && !b.tools_needed.includes(s.prefix));
  const addOff = offers.length
    ? select(
        "Turn off another tool",
        "",
        [{ v: "", t: "Turn off…" }, ...offers.map((s) => ({ v: s.prefix, t: s.name }))],
        (v) => {
          if (!v) return;
          b.tools_off = [...b.tools_off, v];
          savePublic();
          paint();
        },
      )
    : null;
  const tools = h(
    "div",
    { class: "brief-tools" },
    b.tools_needed.length ? h("p", {}, "Needs ", b.tools_needed.map(nameOf).join(", ")) : null,
    b.tools_off.length
      ? h(
          "div",
          { class: "tool-chips", "aria-label": "Turned off" },
          ...b.tools_off.map((p) =>
            h(
              "button",
              {
                type: "button",
                class: "tool-chip",
                "aria-label": `${nameOf(p)} is off; turn it back on`,
                onclick: () => {
                  b.tools_off = b.tools_off.filter((x) => x !== p);
                  savePublic();
                  paint();
                },
              },
              h("s", {}, nameOf(p)),
            ),
          ),
        )
      : h("p", { class: "quiet" }, "Nothing turned off."),
    addOff,
    b.skills.length ? h("p", { class: "quiet" }, `Load: ${b.skills.join(", ")}`) : null,
  );

  const prereqs = b.prerequisites.length
    ? h(
        "ul",
        { class: "brief-prereqs" },
        ...b.prerequisites.map((p, i) => {
          const box = h("input", { type: "checkbox", checked: ticks.has(i) }) as HTMLInputElement;
          box.addEventListener("change", () => {
            if (box.checked) ticks.add(i);
            else ticks.delete(i);
            paint();
          });
          return h("li", {}, h("label", {}, box, h("span", {}, h("strong", {}, p.what), p.why ? h("span", { class: "quiet" }, ` ${p.why}`) : null)));
        }),
      )
    : h("p", { class: "quiet" }, "Nothing; it can start now.");

  const copyCmd = h(
    "button",
    { type: "button", class: local ? "ghost" : "primary", id: "copy-command", disabled: !ready, onclick: () => void copy(b, "command") },
    local ? "Run in the cloud anyway" : "Copy command",
  );
  const copyBrief = h("button", { type: "button", class: local ? "primary" : "ghost", id: "copy-brief", disabled: Boolean(invalid.get(b.id)?.size), onclick: () => void copy(b, "brief") }, "Copy brief");

  return h(
    "article",
    { class: "brief", id: "brief", "aria-labelledby": "brief-h" },
    h(
      "header",
      {},
      h("h2", { id: "brief-h" }, b.headline),
      h("p", { class: "brief-size" }, sizeLine(b)),
      b.source ? h("span", { class: "turn-src" }, SOURCE_LABEL[b.source]) : null,
    ),
    h(
      "dl",
      { class: "brief-grid" },
      ...row("Goal", b.goal, b.why ? h("span", { class: "quiet brief-why" }, b.why) : null),
      ...(b.done.length ? row("Done when", list(b.done)) : []),
      ...(b.out_of_scope.length ? row("Not this time", list(b.out_of_scope, "oos")) : []),
      ...row("Runs on", runsOn, where),
      ...row("Time", time, h("p", { class: "quiet small", id: "tripwire" }, tripwireText(b))),
      ...row("Tools", tools),
      ...(b.guidance.length ? row("Your rules", ...b.guidance.map((g) => h("blockquote", {}, g))) : []),
      ...row("Before it starts", prereqs),
      ...(b.check_ins.length ? row("Comes back to you", list(b.check_ins)) : []),
    ),
    h(
      "div",
      { class: "think-actions brief-actions" },
      h("p", { class: "think-msg", role: "status" }, actionMsg || message),
      copyBrief,
      copyCmd,
    ),
    Q.owner ? null : h("p", { class: "quiet small" }, "Illustration: Jordan's tools are made up, and only your own Bug Me can hear back from a session."),
    h("details", { class: "brief-cmd", id: "brief-cmd" }, h("summary", {}, "The command"), h("pre", {}, h("code", {}, buildCommand(b, catalog)))),
    report(b),
  );
}

function report(b: Shown): HTMLElement | null {
  const r = b.report;
  if (!r) return null;
  const synthetic = b.synthetic_report;
  const since = synthetic ? synthetic.minutes : b.dispatched_at ? Math.max(0, Math.round((Date.parse(r.at) - Date.parse(b.dispatched_at)) / 60_000)) : null;
  const asks = synthetic ? synthetic.asks : (b.asks ?? 0);
  const facts = [
    since === null ? null : `${since} min since copied (estimate ${b.estimate_minutes})`,
    `asked you ${asks === 0 ? "nothing" : asks === 1 ? "once" : `${asks} times`}`,
    r.cost_usd === undefined ? "cost not reported" : `$${r.cost_usd.toFixed(2)}`,
    `scope ${r.scope}`,
  ].filter(Boolean);
  return h(
    "section",
    { class: "brief-report", "aria-label": "How it went" },
    h("h3", {}, synthetic ? "How it went · synthetic" : "How it went"),
    synthetic ? h("p", { class: "quiet small" }, "In real use, the session sends this back when it finishes or stops.") : null,
    h("p", { class: "brief-outcome" }, h("strong", {}, r.outcome), " · ", facts.join(" · ")),
    h("p", {}, r.summary),
  );
}

async function copy(b: Shown, what: "command" | "brief"): Promise<void> {
  // The text is fixed at the click, from the fields as they are now.
  const text = what === "command" ? buildCommand(b, catalog) : briefText(b, catalog);
  actionMsg = "";
  try {
    if (Q.owner) {
      // On /me the fields as copied are what ran: store them, and start the clock, before the text is
      // released. The clipboard call itself stays inside the click (Safari refuses one made after an
      // await), with a promise that resolves once the save has landed.
      const { model, effort, permission_mode, estimate_minutes, budget_usd, tools_off } = b;
      const saved = api<{ brief: Brief }>(`/api/me/briefs/${b.id}/dispatched`, { model, effort, permission_mode, estimate_minutes, budget_usd, tools_off });
      const wrote = typeof ClipboardItem !== "undefined"
        ? navigator.clipboard.write([new ClipboardItem({ "text/plain": saved.then(() => new Blob([text], { type: "text/plain" })) })])
        : saved.then(() => navigator.clipboard.writeText(text));
      // Only the clock comes back: edits made while this was out stay as they are.
      b.dispatched_at = (await saved).brief.dispatched_at;
      await wrote;
    } else await navigator.clipboard.writeText(text);
    actionMsg = what === "command" ? "Copied. Paste it in a terminal, in the folder where the work should happen." : "Brief copied.";
  } catch (e) {
    actionMsg = `Couldn't copy it (${(e as Error).message}). Open "The command" below and copy it from there.`;
  }
  if (!Q.owner && what === "command" && !b.report) {
    // The public demo shows what a session would send back, labeled synthetic.
    const ex = DISPATCH_EXAMPLES.find((x) => x.task === b.task)?.report;
    if (ex) {
      const { minutes, asks, ...rest } = ex;
      b.dispatched_at = new Date().toISOString();
      b.report = { ...rest, at: b.dispatched_at };
      b.synthetic_report = { minutes, asks };
    }
  }
  savePublic();
  paint();
  announce(actionMsg);
}
