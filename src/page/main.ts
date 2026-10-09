// The Bug Me page. No framework: state lives in one object, render() redraws from it, and every
// piece of model text is inserted as text (never as HTML). The choices about when to push back, ask
// why, or propose guidance are made by src/shared/lifecycle.ts, not here.

import { buildAgenda } from "../shared/agenda";
import { EXAMPLES } from "../shared/examples";
import { REROUTE_CONCURRENCY } from "../shared/constants";
import {
  GLOW_START,
  type GlowEvent,
  type Guess,
  type Mood,
  hasBasis,
  keptFact,
  withFact,
  moodAfter,
  nextGlow,
  shouldAskWhy,
  shouldProposeGuidance,
  shouldPushBack,
  topGuess,
} from "../shared/lifecycle";
import type { Card, Decision, Fact, FactOutput, Persona, RouteKind, Rule, Source } from "../shared/types";

// ---------- Types and state ----------

type Unavailable = { id: string; unavailable: string };
type AnyCard = Card | Unavailable;
const isCard = (c: AnyCard | undefined): c is Card => Boolean(c) && !("unavailable" in (c as object));

interface Queue {
  persona: Persona;
  rules: Rule[];
  facts: Fact[];
  decisions: Decision[];
  cards: AnyCard[];
  live_available: boolean;
  mode: "fake" | "live" | "recorded";
  turnstile_site_key: string | null;
}

interface Answer {
  initial: string;
  final: string;
  basis: string;
  guess: Guess;
  route: RouteKind;
  pushback: string | null;
  send_down: string;
  marks: string[];
}

/** One entry in the record: every guess made before an answer, the answer, the basis and the marks. */
interface RecordEvent {
  at: string;
  kind: string;
  id?: string;
  [k: string]: unknown;
}

interface State {
  rules: Rule[];
  facts: Fact[];
  cards: Record<string, AnyCard>;
  answered: Record<string, Answer>;
  /** Settled decisions the person undid; they come back as check-ins and are never re-settled. */
  reopened: string[];
  settledMarks: Record<string, string[]>;
  record: RecordEvent[];
  glow: number;
  mood: Mood;
  pushbacksUsed: number;
  current: string | null;
  /** id -> a one-line note on why its route just changed. */
  changes: Record<string, string>;
  pending: string[];
  newFacts: string[];
  /** Bumped on every rule or fact change; answers from an older version are ignored. */
  version: number;
}

const STORE_KEY = "bugme.state.v1";
let Q: Queue;
let S: State;
let byId = new Map<string, Decision>();

/** The in-progress answer on the card in front of the person (not persisted mid-flow). */
interface Flow {
  id: string;
  choice: string | null;
  basis: string;
  phase: "choose" | "busy" | "pushback" | "why" | "proposal" | "done";
  pushback: string | null;
  initial: string | null;
  guess: Guess | null;
  send_down: string;
  proposal: (FactOutput & { reroute: string[]; source: Source }) | null;
  message: string;
  /** Decisions whose route changed because of guidance kept on this card. */
  rerouted: string[];
}
let F: Flow | null = null;

function fresh(q: Queue): State {
  return {
    rules: structuredClone(q.rules),
    facts: structuredClone(q.facts),
    cards: Object.fromEntries(q.cards.map((c) => [c.id, c])),
    answered: {},
    reopened: [],
    settledMarks: {},
    record: [],
    glow: GLOW_START,
    mood: "neutral",
    pushbacksUsed: 0,
    current: null,
    changes: {},
    pending: [],
    newFacts: [],
    version: 0,
  };
}

function save(): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(S));
  } catch {
    /* storage may be unavailable (private window, blocked); the page still works without it */
  }
}

function load(q: Queue): State {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as State;
      if (s && s.cards && s.rules && s.facts && s.answered) {
        // Cards the person's own changes produced are kept; every other card comes fresh from this
        // load, so a redeploy (new seal key, new recorded run) never leaves stale sealed guesses behind.
        const base = fresh(q);
        const kept = Object.fromEntries(Object.entries(s.cards).filter(([id]) => s.changes?.[id]));
        return { ...base, ...s, cards: { ...base.cards, ...kept }, pending: [] };
      }
    }
  } catch {
    /* corrupted or unavailable storage: start fresh */
  }
  return fresh(q);
}

function log(kind: string, data: Record<string, unknown> = {}): void {
  S.record.push({ at: new Date().toISOString(), kind, ...data });
}

// ---------- DOM helpers ----------

type Child = Node | string | null | undefined | false;
function h(tag: string, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
const $ = (id: string) => document.getElementById(id)!;
function announce(text: string): void {
  $("announce").textContent = text;
}

/** The session token that lets this visit make live calls, once a Turnstile check has passed. */
let session: string | null = null;
let sessionPending: Promise<string | null> | null = null;

async function api<T>(path: string, body?: unknown, retried = false): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (session) headers["x-bugme-session"] = session;
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers, body: JSON.stringify(body) });
  const data = (await res.json()) as { error?: string; unavailable?: boolean; needs_session?: boolean };
  if (res.status === 401 && data.needs_session && !retried) {
    session = await (sessionPending ??= humanCheck().finally(() => (sessionPending = null)));
    if (session) return api<T>(path, body, true);
  }
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { unavailable: Boolean(data.unavailable || data.needs_session) });
  return data as T;
}

/**
 * Show a Turnstile check in a small dialog and trade its token for a session. Resolves null if the
 * check cannot run (no site key, script blocked) or the visitor closes it.
 */
function humanCheck(): Promise<string | null> {
  const siteKey = Q?.turnstile_site_key;
  if (!siteKey) return Promise.resolve(null);
  return new Promise((resolve) => {
    const box = h("div", { class: "ts-box" });
    const close = h("button", { type: "button", class: "ghost" }, "Not now");
    const dlg = h(
      "dialog",
      { class: "ts", "aria-labelledby": "ts-h" },
      h("h2", { id: "ts-h" }, "One quick check before live calls"),
      h("p", {}, "Live Claude calls cost real money, so the first one needs a check that you're a person. Recorded answers never do."),
      box,
      close,
    ) as HTMLDialogElement;
    document.body.append(dlg);
    const finish = (v: string | null) => {
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    close.addEventListener("click", () => finish(null));
    dlg.showModal();
    const W = window as unknown as { turnstile?: { render: (el: HTMLElement, o: Record<string, unknown>) => void } };
    const render = () =>
      W.turnstile!.render(box, {
        sitekey: siteKey,
        callback: async (token: string) => {
          try {
            const r = await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
            const d = (await r.json()) as { session?: string };
            finish(r.ok && d.session ? d.session : null);
          } catch {
            finish(null);
          }
        },
        "error-callback": () => finish(null),
      });
    if (W.turnstile) render();
    else {
      const sc = document.createElement("script");
      sc.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      sc.async = true;
      sc.onload = render;
      sc.onerror = () => finish(null);
      document.head.append(sc);
    }
  });
}

const ROUTE_LABEL: Record<RouteKind, string> = { settle: "Settled for you", check_in: "Quick check-in", decide: "Your decision" };
const SOURCE_LABEL: Record<Source, string> = { live: "live Claude", cached: "cached Claude", recorded: "recorded Claude run", code: "code stand-in" };

// ---------- Derived views ----------

function routeOf(id: string): RouteKind | null {
  const c = S.cards[id];
  if (!isCard(c)) return null;
  if (S.reopened.includes(id) && c.route === "settle") return "check_in";
  return c.route;
}

function routesForAgenda(): Record<string, RouteKind> {
  const r: Record<string, RouteKind> = {};
  for (const d of Q.decisions) {
    const k = routeOf(d.id);
    if (k) r[d.id] = k;
  }
  return r;
}

function agenda() {
  return buildAgenda(Q.decisions, routesForAgenda(), Q.persona.projects, new Set(Object.keys(S.answered)));
}

/** Decisions not yet answered by the person, including ones Bug Me settled: all can be re-routed. */
function waitingIds(): string[] {
  return Q.decisions.filter((d) => !S.answered[d.id]).map((d) => d.id);
}

function firstAgendaId(): string | null {
  const a = agenda();
  for (const s of a.sections) {
    const first = s.decisions[0] ?? s.check_ins[0];
    if (first) return first.id;
  }
  return null;
}

// ---------- Rendering ----------

function quoteLine(c: Card): Child {
  const q = c.rule_quoted || c.fact_quoted;
  return h("p", { class: "why" }, c.why_here, q && !c.why_here.includes(q) ? h("span", {}, " ", h("q", {}, q)) : null);
}

function renderNow(): void {
  const root = $("now");
  root.replaceChildren();
  if (!S.current || S.answered[S.current] && (!F || F.id !== S.current)) S.current = firstAgendaId();
  const id = F && F.id === S.current ? F.id : S.current;
  if (!id) {
    root.append(
      h("div", { class: "card" }, h("h3", {}, "Nothing is waiting on you."), h("p", { class: "context" }, "Every agent is unblocked. The firefly is resting; so can you.")),
    );
    return;
  }
  const d = byId.get(id)!;
  const c = S.cards[id];
  if (!F || F.id !== id) F = { id, choice: null, basis: "", phase: "choose", pushback: null, initial: null, guess: null, send_down: "", proposal: null, message: "", rerouted: [] };
  if (!isCard(c)) {
    root.append(h("div", { class: "card" }, h("h3", {}, d.question), h("p", { class: "adjusted" }, `Couldn't evaluate this one: ${c?.unavailable ?? "no route yet"}.`)));
    return;
  }
  const route = routeOf(id)!;
  const project = Q.persona.projects.find((p) => p.id === d.project)!;
  const locked = F.phase !== "choose";

  const opts = h(
    "div",
    { class: "options", role: "group", "aria-label": "Options" },
    ...d.options.map((o) =>
      h(
        "button",
        {
          type: "button",
          class: "opt",
          "aria-pressed": String(F!.choice === o.key),
          disabled: locked,
          onclick: () => {
            F!.choice = o.key;
            renderNow();
          },
        },
        h("b", {}, `${o.key}. ${o.label}`),
        o.description ? h("span", {}, o.description) : null,
        o.key === d.recommended ? h("i", { class: "agent-pick" }, "the agent's pick") : null,
      ),
    ),
  );

  const variants =
    d.explore?.kind === "variants"
      ? h(
          "div",
          { class: "variants" },
          ...Object.entries(d.explore.variants).map(([k, file]) =>
            h(
              "figure",
              { class: "variant", style: "margin:0" },
              h("h4", {}, h("span", {}, `${k}. ${d.options.find((o) => o.key === k)?.label ?? k}`), h("span", {}, "built on a preview branch")),
              h("iframe", { src: `/variants/${file}`, title: `Clickable prototype, option ${k}`, sandbox: "allow-scripts", loading: "lazy" }),
            ),
          ),
        )
      : null;

  const chosen = d.options.find((o) => o.key === F!.choice);
  const basisLabel =
    d.explore && chosen
      ? `In a sentence: what happens next if you choose ${chosen.label}?`
      : route === "decide"
        ? "Why? Say it or type it."
        : "Why? (optional for a quick check)";
  const ta = h("textarea", { id: "basis", rows: 2, placeholder: "Talk it through. Your reason becomes guidance every agent follows.", disabled: locked }) as HTMLTextAreaElement;
  ta.value = F.basis;
  ta.addEventListener("input", () => {
    F!.basis = ta.value;
    submit.toggleAttribute("disabled", !canSubmit());
  });
  const mic = micButton(ta, locked);
  // A substantive decision asks for its basis up front. A quick check-in is answered in one click;
  // if the answer surprises Bug Me, it asks "I'm curious: why?" before revealing its guess.
  const basis =
    route === "decide"
      ? h("div", { class: "basis" }, h("label", { for: "basis" }, basisLabel), h("div", { class: "basis-row" }, ta, mic), locked ? null : exampleButton(d, ta))
      : null;

  const canSubmit = () => Boolean(F!.choice) && (route !== "decide" || hasBasis(F!.basis) || skipBasis);
  let skipBasis = false;
  const submit = h("button", { type: "button", class: "primary", disabled: !canSubmit() || locked, onclick: () => void answer(d, route) }, "Decide") as HTMLButtonElement;
  const skip =
    route === "decide" && !locked
      ? h(
          "button",
          {
            type: "button",
            class: "linkish",
            onclick: () => {
              skipBasis = true;
              submit.disabled = !canSubmit();
              announce("You can decide without a reason. It won't teach the fleet anything.");
            },
          },
          "decide without a reason",
        )
      : null;

  const card = h(
    "article",
    { class: "card", "data-route": route, "aria-labelledby": "now-q" },
    h(
      "div",
      { class: "meta" },
      h("span", { class: `chip ${route}` }, ROUTE_LABEL[route]),
      h("span", {}, project.name),
      h("span", { class: "chain" }, d.agent.join(" › ")),
      h("span", { class: `badge ${c.source}`, title: "Where this card's routing came from" }, SOURCE_LABEL[c.source]),
    ),
    h("h3", { id: "now-q" }, c.headline || d.question),
    c.in_your_terms ? h("p", { class: "briefing-text" }, c.in_your_terms) : null,
    c.adjusted
      ? h(
          "div",
          { class: "why" },
          h("p", { style: "margin:0" }, h("b", {}, "Code adjusted this route. "), c.adjusted),
          h("details", { class: "claude-why" }, h("summary", {}, "Claude's own reasoning"), h("p", {}, c.why_here)),
        )
      : quoteLine(c),
    S.changes[id] ? h("p", { class: "adjusted" }, S.changes[id]) : null,
    (c.headline || c.in_your_terms) && c.headline !== d.question
      ? h("details", { class: "original" }, h("summary", {}, "What the agent actually asked"), h("blockquote", {}, d.question))
      : null,
    h("p", { class: "context" }, d.context),
    variants,
    opts,
    basis,
    locked ? null : h("div", { class: "actions" }, submit, skip),
    followup(d, route),
  );
  root.append(card);
}

function micButton(ta: HTMLTextAreaElement, disabled: boolean): HTMLElement {
  const W = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
  const Ctor = W.SpeechRecognition ?? W.webkitSpeechRecognition;
  if (!Ctor) return h("span", { hidden: true });
  let rec: SpeechRec | null = null;
  const b = h("button", { type: "button", class: "mic", "aria-pressed": "false", "aria-label": "Answer by voice", title: "Answer by voice", disabled }, "🎙") as HTMLButtonElement;
  b.addEventListener("click", () => {
    if (rec) {
      rec.stop();
      return;
    }
    rec = new Ctor();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = true;
    const base = ta.value ? `${ta.value} ` : "";
    rec.onresult = (e: SpeechEvent) => {
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      ta.value = base + text;
      ta.dispatchEvent(new Event("input"));
    };
    rec.onend = () => {
      rec = null;
      b.setAttribute("aria-pressed", "false");
    };
    rec.start();
    b.setAttribute("aria-pressed", "true");
  });
  return b;
}
interface SpeechRec {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: (e: SpeechEvent) => void;
  onend: () => void;
  start(): void;
  stop(): void;
}
interface SpeechEvent {
  results: { length: number; [i: number]: { [j: number]: { transcript: string } } };
}

/**
 * A button that fills in the recorded example's reason, offered only when live calls are off and
 * the visitor picked the example's option. It is labeled; it never replaces the visitor's own words.
 */
function exampleButton(d: Decision, ta: HTMLTextAreaElement): Child {
  const ex = EXAMPLES.find((e) => e.id === d.id && e.choice === F?.choice);
  if (!ex || Q.mode === "live") return null;
  return h(
    "p",
    { class: "example" },
    "Live calls are off, so only recorded answers can be evaluated. ",
    h(
      "button",
      {
        type: "button",
        class: "linkish",
        onclick: () => {
          ta.value = ex.reason;
          ta.dispatchEvent(new Event("input"));
          F!.basis = ex.reason;
        },
      },
      "Use the recorded example reason",
    ),
  );
}

function followup(d: Decision, route: RouteKind): Child {
  if (!F || F.id !== d.id) return null;
  if (F.phase === "busy") return h("div", { class: "followup" }, h("p", {}, F.message || "One moment…"));
  if (F.phase === "pushback") {
    const chosen = d.options.find((o) => o.key === F!.choice)!;
    return h(
      "div",
      { class: "followup push", role: "alert" },
      h("p", { class: "big" }, "Before this goes out: you told me something that points the other way."),
      h("p", {}, h("q", {}, F.pushback ?? "")),
      h("p", {}, `Still go with “${chosen.label}”?`),
      h(
        "div",
        { class: "actions" },
        h("button", { type: "button", class: "primary", onclick: () => void finalize(d, route, F!.choice!, "kept") }, "Yes, this one is an exception"),
        ...d.options
          .filter((o) => o.key !== F!.choice)
          .map((o) => h("button", { type: "button", class: "ghost", onclick: () => void finalize(d, route, o.key, "changed") }, `Change to “${o.label}”`)),
      ),
    );
  }
  if (!F.guess) return F.message ? h("div", { class: "followup" }, h("p", {}, F.message)) : null;

  const top = topGuess(F.guess);
  const guessed = d.options.find((o) => o.key === top.option)!;
  const parts: Child[] =
    F.phase === "why"
      ? []
      : [h("p", {}, h("b", {}, "Bug Me's guess, hidden until now: "), `${guessed.label} (${Math.round(top.p * 100)}%).`, top.option === F.choice ? " You agreed." : " You went the other way.")];
  if (F.phase === "why") {
    const ta = h("textarea", { class: "fact-edit", id: "why", rows: 2, placeholder: "Say it or type it" }) as HTMLTextAreaElement;
    parts.push(
      h("p", { class: "big" }, "I'm curious: why?"),
      h("p", {}, "Your answer surprised me. Your reason can become guidance for every agent."),
      h("label", { for: "why", class: "sr-only" }, "Why did you choose that?"),
      h("div", { class: "basis-row" }, ta, micButton(ta, false)),
      exampleButton(d, ta),
      h(
        "div",
        { class: "actions" },
        h("button", { type: "button", class: "primary", onclick: () => { F!.basis = ta.value; void propose(d); } }, "Tell Bug Me"),
        h("button", { type: "button", class: "linkish", onclick: () => done(d, "Skipped the why.") }, "skip"),
      ),
    );
  }
  if (F.phase === "proposal" && F.proposal) {
    const p = F.proposal;
    if (p.kind === "none") {
      parts.push(h("p", {}, p.confirm || "Got it. Nothing to remember from that one."));
      parts.push(h("button", { type: "button", class: "primary", onclick: () => done(d, "") }, "Next decision"));
    } else {
      const input = h("textarea", { class: "fact-edit", id: "fact-text", rows: 2, "aria-label": "Proposed guidance (you can edit it)" }) as HTMLTextAreaElement;
      input.value = p.text;
      const replacing = p.kind === "replace" ? S.facts.find((f) => f.id === p.replaces) : undefined;
      parts.push(
        h("p", {}, p.confirm),
        h("p", {}, h("b", {}, replacing ? `Replace “${replacing.text}” with:` : "Remember this for every agent?")),
        input,
        h("p", { class: "senddown" }, `${SOURCE_LABEL[p.source]} · would re-check ${p.reroute.length} waiting decision${p.reroute.length === 1 ? "" : "s"}`),
        h(
          "div",
          { class: "actions" },
          h("button", { type: "button", class: "primary", onclick: () => void keepFact(d, input.value, p) }, "Keep it"),
          h("button", { type: "button", class: "ghost", onclick: () => { log("guidance_discarded", { id: d.id, text: p.text }); done(d, "Discarded."); } }, "Don't keep"),
        ),
      );
    }
  }
  if (F.phase === "done") {
    if (F.message) parts.push(h("p", {}, F.message));
    for (const rid of F.rerouted) {
      const rd = byId.get(rid)!;
      const rc = S.cards[rid];
      parts.push(
        h(
          "p",
          { class: "rerouted" },
          h("b", {}, "Re-routed: "),
          (isCard(rc) && rc.headline) || rd.question,
          " ",
          h("span", {}, S.changes[rid] ?? ""),
          " ",
          S.answered[rid] ? null : h("button", { type: "button", class: "linkish", onclick: () => { S.current = rid; F = null; render(); $("now").focus(); } }, "Look at it"),
        ),
      );
    }
    parts.push(
      h("p", { class: "senddown" }, `Sent down to ${d.agent[d.agent.length - 1]} (simulated): ${F.send_down || "proceed with your choice."}`),
      h(
        "div",
        { class: "after-marks" },
        markButton(d.id, "shouldnt_have_come", "This shouldn't have come to me"),
        h("button", { type: "button", class: "primary", onclick: () => next() }, "Next decision"),
      ),
    );
  }
  return h("div", { class: "followup reveal", "aria-live": "polite" }, ...parts);
}

function markButton(id: string, mark: string, label: string): HTMLElement {
  const marks = S.answered[id]?.marks ?? S.settledMarks[id] ?? [];
  const on = marks.includes(mark);
  return h(
    "button",
    {
      type: "button",
      "aria-pressed": String(on),
      onclick: () => {
        const list = S.answered[id] ? S.answered[id].marks : (S.settledMarks[id] ??= []);
        if (list.includes(mark)) list.splice(list.indexOf(mark), 1);
        else {
          list.push(mark);
          const ev: GlowEvent = mark === "shouldnt_have_come" ? { kind: "shouldnt_have_come" } : { kind: "correction_mark" };
          glowEvent(ev);
        }
        log("mark", { id, mark, on: list.includes(mark) });
        save();
        render();
      },
    },
    label,
  );
}

function renderAgenda(): void {
  const a = agenda();
  const root = $("agenda");
  root.replaceChildren();
  const current = F?.id ?? S.current;
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
                F = null;
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

function renderSettled(): void {
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

function renderRules(): void {
  const root = $("rules");
  root.replaceChildren();
  for (const r of S.rules) {
    const li = h("li", {}, h("span", { class: "rid" }, r.id));
    const btn = h("button", { type: "button", class: "rtext", title: "Edit this rule", "aria-label": `Edit rule ${r.id}: ${r.text}` }, r.text);
    btn.addEventListener("click", () => {
      const ta = h("textarea", { "aria-label": `Rule ${r.id}` }) as HTMLTextAreaElement;
      ta.value = r.text;
      const saveBtn = h("button", { type: "button", class: "ghost", onclick: () => void editRule(r.id, ta.value) }, "Save and re-route");
      const cancel = h("button", { type: "button", class: "linkish", onclick: () => renderRules() }, "cancel");
      li.replaceChildren(h("span", { class: "rid" }, r.id), h("div", {}, ta, h("div", { class: "row" }, saveBtn, cancel)));
      ta.focus();
    });
    li.append(btn);
    root.append(li);
  }
}

function renderFacts(): void {
  const root = $("facts");
  root.replaceChildren();
  for (const f of S.facts) root.append(h("li", { class: S.newFacts.includes(f.id) ? "new" : "" }, f.text, h("span", { class: "src" }, f.source)));
  const note = $("note");
  note.replaceChildren(...Q.persona.how_to_work_with_me.map((t) => h("li", {}, t)));
  $("note-source").textContent = Q.persona.how_to_work_with_me_source;
}

function renderHeader(): void {
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
      h("button", { type: "button", onclick: () => { S.current = "onsite-flight"; F = null; render(); $("now").focus(); } }, "answer the 6:05am flight question"),
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

function render(): void {
  renderHeader();
  renderNow();
  renderAgenda();
  renderSettled();
  renderRules();
  renderFacts();
}

// ---------- Actions ----------

function glowEvent(e: GlowEvent): void {
  S.glow = nextGlow(S.glow, e);
  const waiting = agenda().sections.length;
  S.mood = moodAfter(e, S.glow, waiting);
}

async function answer(d: Decision, route: RouteKind): Promise<void> {
  if (!F || !F.choice) return;
  const c = S.cards[d.id] as Card;
  F.initial = F.choice;
  F.phase = "busy";
  F.message = "Checking against your record…";
  renderNow();
  try {
    const r = await api<{ pushback: string | null }>("/api/answer", { id: d.id, sealed: c.sealed, choice: F.choice, stage: "check" });
    if (shouldPushBack(r.pushback, S.pushbacksUsed)) {
      S.pushbacksUsed++;
      F.pushback = r.pushback;
      F.phase = "pushback";
      log("pushback", { id: d.id, choice: F.choice, quoted: r.pushback });
      renderNow();
      return;
    }
    await finalize(d, route, F.choice, null);
  } catch (e) {
    F.phase = "choose";
    F.message = `Something went wrong: ${(e as Error).message}`;
    renderNow();
  }
}

async function finalize(d: Decision, route: RouteKind, choice: string, pushbackOutcome: "kept" | "changed" | null): Promise<void> {
  if (!F) return;
  const c = S.cards[d.id] as Card;
  F.choice = choice;
  F.phase = "busy";
  renderNow();
  let r: { guess: Guess; send_down: string };
  try {
    r = await api<{ guess: Guess; send_down: string }>("/api/answer", { id: d.id, sealed: c.sealed, choice, stage: "final" });
  } catch (e) {
    F.phase = "choose";
    F.message = `Couldn't record that answer: ${(e as Error).message}. Try again.`;
    renderNow();
    return;
  }
  F.guess = r.guess;
  F.send_down = r.send_down;
  const basis = F.basis.trim();
  S.answered[d.id] = { initial: F.initial ?? choice, final: choice, basis, guess: r.guess, route, pushback: F.pushback, send_down: r.send_down, marks: [] };
  log("answer", {
    id: d.id,
    route,
    initial: F.initial,
    final: choice,
    basis,
    guess_before_answer: r.guess,
    pushback: F.pushback,
    pushback_outcome: pushbackOutcome,
    source: c.source,
  });
  glowEvent({ kind: "answered", route, basis: hasBasis(basis), againstRecommendation: choice !== d.recommended });
  save();
  if (shouldAskWhy(choice, r.guess, basis)) {
    F.phase = "why";
    renderHeader();
    renderNow();
    (document.getElementById("why") as HTMLTextAreaElement | null)?.focus();
    return;
  }
  if (shouldProposeGuidance(choice, d.recommended, r.guess, basis)) {
    await propose(d);
    return;
  }
  done(d, "");
}

async function propose(d: Decision): Promise<void> {
  if (!F) return;
  const basis = F.basis.trim();
  if (!hasBasis(basis)) {
    done(d, "");
    return;
  }
  S.answered[d.id].basis = basis;
  F.phase = "busy";
  F.message = "Turning that into guidance…";
  renderNow();
  try {
    const p = await api<FactOutput & { reroute: string[]; source: Source }>("/api/fact", {
      id: d.id,
      choice: F.choice,
      reason: basis,
      rules: S.rules,
      facts: S.facts,
      waiting: waitingIds().filter((x) => x !== d.id),
    });
    F.proposal = p;
    F.phase = "proposal";
    log("guidance_proposed", { id: d.id, kind: p.kind, text: p.text, replaces: p.replaces, reroute: p.reroute, source: p.source });
  } catch (e) {
    F.phase = "done";
    F.message = `Couldn't turn that into guidance right now (${(e as Error).message}). Your answer and reason are recorded.`;
  }
  save();
  renderNow();
}

async function keepFact(d: Decision, text: string, p: FactOutput & { reroute: string[] }): Promise<void> {
  const t = text.trim();
  if (!t) return;
  const label = d.options.find((o) => o.key === F?.choice)?.label ?? "";
  const fact = keptFact(S.facts, p, t, label);
  S.facts = withFact(S.facts, fact);
  S.newFacts.push(fact.id);
  S.version++;
  log("guidance_kept", { id: d.id, fact, edited: t !== p.text });
  glowEvent({ kind: "guidance_kept" });
  done(d, `Kept. Every agent now gets: “${t}”`);
  const flow = F;
  const changed = await reroute(p.reroute, `because you told me: “${t.replace(/[.\s]+$/, "")}”`);
  if (flow && F === flow) {
    flow.rerouted = changed;
    renderNow();
  }
}

function done(d: Decision, message: string): void {
  if (!F) return;
  F.phase = "done";
  F.message = message;
  save();
  render();
}

function next(): void {
  F = null;
  S.current = firstAgendaId();
  render();
  $("now").focus();
}

function undo(id: string): void {
  S.reopened.push(id);
  log("undo", { id });
  S.changes[id] = "You undid Bug Me's call, so it's back with you.";
  save();
  render();
  announce("Undone. It's back on your agenda as a quick check-in.");
}

async function editRule(id: string, text: string): Promise<void> {
  const t = text.replace(/\s+/g, " ").trim();
  const old = S.rules.find((r) => r.id === id);
  if (!old || !t || t === old.text) {
    renderRules();
    return;
  }
  S.rules = S.rules.map((r) => (r.id === id ? { ...r, text: t } : r));
  S.version++;
  log("rule_edited", { rule: id, from: old.text, to: t });
  glowEvent({ kind: "rule_edited" });
  save();
  render();
  await reroute(waitingIds(), `because you edited ${id}: “${t.replace(/[.\s]+$/, "")}”`);
}

/** Re-route the given decisions under the current rules and facts, and note every change with its cause. */
async function reroute(ids: string[], cause: string): Promise<string[]> {
  const version = S.version;
  const todo = ids.filter((id) => !S.answered[id]);
  S.pending = [...new Set([...S.pending, ...todo])];
  render();
  const changedIds: string[] = [];
  const queue = [...todo];
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift()!;
      try {
        const card = await api<Card>("/api/route", { id, rules: S.rules, facts: S.facts });
        if (S.version !== version) return; // a newer edit superseded this one; its own re-route wins
        const before = routeOf(id);
        S.cards[id] = card;
        const after = routeOf(id);
        if (before !== after && before && after) {
          changedIds.push(id);
          S.changes[id] = `Moved from “${ROUTE_LABEL[before]}” to “${ROUTE_LABEL[after]}” ${cause}.`;
          log("rerouted", { id, from: before, to: after, cause, source: card.source });
        } else if (card.fact_quoted && cause.includes(card.fact_quoted)) {
          S.changes[id] = `Now framed by what you said ${cause.replace(/^because you told me: /, "")}.`;
        }
      } catch (e) {
        if ((e as { unavailable?: boolean }).unavailable) S.changes[id] = `Couldn't re-check this one: ${(e as Error).message}.`;
      } finally {
        S.pending = S.pending.filter((x) => x !== id);
        render();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(REROUTE_CONCURRENCY, todo.length) }, worker));
  save();
  const n = changedIds.length;
  announce(n ? `${n} waiting decision${n === 1 ? "" : "s"} re-routed ${cause}.` : "Re-checked; nothing waiting changed route.");
  return changedIds;
}

// ---------- Boot ----------

async function boot(): Promise<void> {
  Q = await api<Queue>("/api/queue");
  byId = new Map(Q.decisions.map((d) => [d.id, d]));
  S = load(Q);
  $("export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), persona: Q.persona.name, synthetic: true, rules: S.rules, facts: S.facts, record: S.record }, null, 2)], { type: "application/json" });
    const a = h("a", { href: URL.createObjectURL(blob), download: "bug-me-record.json" });
    a.click();
  });
  $("reset").addEventListener("click", () => {
    S = fresh(Q);
    F = null;
    save();
    render();
    announce("Started the morning over.");
  });
  render();
}

boot().catch((e) => {
  $("now").replaceChildren(h("div", { class: "card" }, h("h3", {}, "Bug Me couldn't load."), h("p", { class: "context" }, String((e as Error).message))));
});
