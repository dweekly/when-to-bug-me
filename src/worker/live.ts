// The live queue's logic (docs/STAGE-7.md), kept free of Workers-only imports so the unit tests can run
// it in Node: turning an agent's ask into a Decision, the owner's persona and starting rules, and the
// ticket lifecycle over a small key-value store (the owner's Durable Object in production, a Map in tests).

import type { Brief, BriefEdits, Catalog, Launch, Report, StoredWalk } from "../shared/dispatch";
import type { OnboardingRun } from "../shared/onboarding";
import { MAX_REASON_CHARS } from "../shared/constants";
import type { Card, Decision, Fact, Persona, Reversible, Rule } from "../shared/types";

/** Options an ask may carry, and the longest texts it may hold. */
export const MIN_ASK_OPTIONS = 2;
/** The card lays options out in columns; three is the most it shows well on a phone. */
export const MAX_ASK_OPTIONS = 3;
/** The most other decisions a fact prompt lists, newest first, so its size (and cost) stays bounded. */
export const MAX_OTHERS_IN_PROMPT = 20;
const MAX_QUESTION_CHARS = 600;
const MAX_CONTEXT_CHARS = 4000;
const MAX_LABEL_CHARS = 120;
const MAX_NOTE_CHARS = 300;
const MAX_NAME_CHARS = 60;
/** What an option without a declared reversibility or cost counts as: never eligible to settle. */
export const UNKNOWN_COST_USD = 9999;
/**
 * What Bug Me may settle alone on the owner's behalf. The asking agent declares an option's cost and
 * reversibility, so the ceiling is the owner's own "about a dollar" rule rather than the simulation's
 * $50, and only a rule that grants permission can clear a ticket (a rule saying something needs the
 * owner's go never does, however the model reads it).
 */
export const OWNER_SETTLE_MAX_USD = 1;
const GRANTS = /just do (it|them)|needs? no permission|go ahead|fine to do/i;
const RESERVES = /\bmine\b|comes to me|ask(ing)? me|my (explicit )?go|never\b/i;
export function grantsPermission(ruleText: string): boolean {
  return GRANTS.test(ruleText) && !RESERVES.test(ruleText.replace(/ask before real money\.?/i, ""));
}
export function reservesDecision(ruleText: string): boolean {
  return RESERVES.test(ruleText);
}
export const OWNER_SETTLE_LIMITS = { maxCostUsd: OWNER_SETTLE_MAX_USD, clears: grantsPermission, reserves: reservesDecision };

/** How many settled tickets the queue keeps showing (for Decided for you). */
export const SETTLED_SHOWN = 50;
/** How long an answered ticket stays available to the page for its follow-ups. */
const ANSWERED_KEPT_MS = 24 * 60 * 60 * 1000;

export class AskError extends Error {}

export interface AskOption {
  key: string;
  label: string;
  pros?: string;
  cons?: string;
  reversible?: Reversible;
  cost_usd?: number;
}

export interface Ask {
  question: string;
  options: AskOption[];
  recommended?: string;
  context: string;
  project: string;
  session: string;
}

export type TicketStatus = "open" | "settled" | "answered" | "set-aside" | "reopened";

/** Why a set-aside ticket was set aside, kept so every device can list and resume it. */
export interface Aside {
  kind: string;
  reason: string;
  instruction: string;
  at: string;
}

/** What the asking session is told, merged as David adds to it (a late reason, kept guidance). */
export interface TicketAnswer {
  outcome: "option" | "other" | "rejected" | "ask-agent" | "set-aside" | "reopened" | "resumed";
  by: "rule" | "owner";
  choice?: string;
  label?: string;
  course?: string;
  /** The written rule that settled it, for answers by rule. */
  rule?: string;
  reason?: string;
  conditions?: string;
  questions?: string[];
  instruction?: string;
  guidance?: string;
  at: string;
}

export interface Ticket {
  decision: Decision;
  /** The project as the agent named it; `decision.project` holds its id. */
  project_name?: string;
  card: Card;
  status: TicketStatus;
  created_at: string;
  answer?: TicketAnswer;
  aside?: Aside;
  /** Set when routing failed: the ticket is the owner's to decide, with the reason shown. */
  unrouted?: string;
  /** The dispatch brief the asking session was started from (docs/STAGE-8.md), if it said. */
  brief?: string;
}

const str = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
function text(v: unknown, max: number, field: string, required = true): string {
  const t = str(v);
  if (required && !t) throw new AskError(`${field} is required`);
  if (t.length > max) throw new AskError(`${field} is longer than ${max} characters`);
  return t;
}

/** How many briefs the owner's Dispatch view lists. */
export const MAX_BRIEFS_SHOWN = 30;

/** A brief's id: "b-" and 10 characters, like a ticket's. */
export function briefId(): string {
  const b = crypto.getRandomValues(new Uint8Array(10));
  return `b-${Array.from(b, (x) => "abcdefghijkmnpqrstuvwxyz23456789"[x % 32]).join("")}`;
}
export const BRIEF_ID_RE = /^b-[a-z0-9]{10}$/;

/** The brief an ask names, if it's well formed; anything else is ignored rather than refused. */
export function askBrief(b: Record<string, unknown>): string | undefined {
  return typeof b.brief === "string" && BRIEF_ID_RE.test(b.brief) ? b.brief : undefined;
}

/** A short, URL-safe ticket id. */
export function ticketId(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return `t-${Array.from(b, (x) => "abcdefghijkmnpqrstuvwxyz23456789"[x % 32]).join("")}`;
}

/**
 * Check an agent's ask and turn it into a Decision in the simulation's shape, so routing, the card and
 * the conversation run unchanged. Bounds come from the agent's own declaration; a missing one counts
 * as irreversible and expensive, so it can never settle.
 */
export function decisionFromAsk(raw: unknown, id: string): Decision {
  if (!raw || typeof raw !== "object") throw new AskError("the ask must be an object");
  const b = raw as Record<string, unknown>;
  const question = text(b.question, MAX_QUESTION_CHARS, "question");
  const context = text(b.context ?? "", MAX_CONTEXT_CHARS, "context", false);
  // The decision carries the project's id, as the simulation's do; the name the agent gave is kept for display.
  const project = projectId(text(b.project ?? "", MAX_NAME_CHARS, "project", false) || "Other");
  const session = text(b.session ?? "", MAX_NAME_CHARS, "session", false) || "a Claude Code session";
  if (!Array.isArray(b.options) || b.options.length < MIN_ASK_OPTIONS || b.options.length > MAX_ASK_OPTIONS) {
    throw new AskError(`options must be a list of ${MIN_ASK_OPTIONS} to ${MAX_ASK_OPTIONS}`);
  }
  const keys = "ABCD";
  const bounds: Decision["bounds"] = {};
  const options = b.options.map((o, i) => {
    const x = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
    const key = keys[i];
    const label = text(x.label, MAX_LABEL_CHARS, `options[${i}].label`);
    const pros = text(x.pros ?? "", MAX_NOTE_CHARS, `options[${i}].pros`, false);
    const cons = text(x.cons ?? "", MAX_NOTE_CHARS, `options[${i}].cons`, false);
    const declared = x.reversible === "yes" || x.reversible === "partly" || x.reversible === "no";
    const reversible = declared ? (x.reversible as Reversible) : "no";
    const costKnown = typeof x.cost_usd === "number" && Number.isFinite(x.cost_usd) && x.cost_usd >= 0;
    const cost = costKnown ? (x.cost_usd as number) : UNKNOWN_COST_USD;
    bounds[key] = { reversible, cost_usd: cost };
    // The model sees the agent's declaration too, labeled as the agent's claim; enforcement uses bounds.
    const claim = `The agent says: ${declared ? `reversible: ${reversible}` : "reversibility not stated"}; ${costKnown ? `costs $${cost}` : "cost not stated"}`;
    const description = [pros && `For: ${pros}`, cons && `Against: ${cons}`, claim].filter(Boolean).join("; ");
    return { key, label, description };
  });
  // The agent may name its recommendation by key or by label.
  const rec = str(b.recommended);
  const named = options.find((o) => o.key === rec || o.label === rec)?.key;
  // Routing needs a key, but the page must never claim the agent picked one it didn't (docs/STAGE-6F.md).
  const recommended = named ?? options[0].key;
  return {
    id,
    category: "Live",
    project,
    agent: [session],
    waiting_minutes: 0,
    unblocks: 1,
    question,
    options,
    recommended,
    ...(named ? {} : { no_recommendation: true as const }),
    context,
    bounds,
    tags: [],
  };
}

/** The project name an ask gave, for display (decisionFromAsk stores only its id). */
export function askProjectName(raw: unknown): string {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return str(b.project).slice(0, MAX_NAME_CHARS) || "Other";
}

/** The owner's persona: David, from the "How we work" section of his CLAUDE.md. Projects are the ones his tickets name. */
/** The owner's note: once onboarding's revised note is kept (docs/STAGE-10.md), it replaces the distilled one. */
export interface OwnerNote {
  lines: string[];
  source: string;
  /** The facts its lines came from: editing or deleting one changes the note too. */
  fact_ids?: string[];
}

export function ownerPersona(projects: { id: string; name: string }[], note?: OwnerNote): Persona {
  return {
    synthetic: false,
    name: "David",
    first_name: "David",
    pronouns: "they/them",
    role: "Founder",
    company: "a small independent studio",
    company_blurb: "where Claude Code sessions do most of the engineering across several software projects",
    fleet_size: Math.max(1, projects.length),
    projects: projects.map((p) => ({ id: p.id, name: p.name, blurb: `the ${p.name} project` })),
    how_to_work_with_me: note?.lines ?? [
      "Ask every question whose answer changes the design all at once, each with a recommended default.",
      "Plain English first, rigor underneath.",
      "Push back on a bad plan and offer better ideas.",
      "Test a testable claim before asserting it, or label it an unverified hypothesis.",
    ],
    how_to_work_with_me_source: note?.source ?? "Distilled from the \"How we work\" section of David's CLAUDE.md.",
  };
}

export function projectId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "other";
}

/** The owner's starting rules (docs/STAGE-7.md), distilled from their CLAUDE.md. Editable on /me. */
export const OWNER_RULES: Rule[] = [
  { id: "L1", text: "Business intent and product decisions are mine; technical calls are yours. Make routine judgment calls yourself." },
  { id: "L2", text: "Production deploys need my explicit go." },
  { id: "L3", text: "Staging deploys from a commit on main need no permission: deploy, verify, report." },
  { id: "L4", text: "Spends of about a dollar need no permission; report the cost. Ask before real money." },
  { id: "L5", text: "Never delete, overwrite or prune data, rm -rf, or force-push without asking me." },
  { id: "L6", text: "Anything that goes out under my name (email, posts, board communication) comes to me." },
  { id: "L7", text: "Credentials and secrets never go in a repo." },
  { id: "L8", text: "MVP and product repos get a Codex review before merge; a new blocker on the second review pass comes to me." },
  { id: "L9", text: "Other people's networks: passive only, with no scans or probes unless the owner is present and has said yes." },
  { id: "L10", text: "Small, clear changes: just do them, with no plan or interview." },
  { id: "L11", text: "Merge with merge commits, never squash." },
];

/** The store a LiveQueue runs on: the Durable Object's storage, or a Map in tests. */
export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  list<T>(prefix: string): Promise<Map<string, T>>;
}

export function mapKV(): KV {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => structuredClone(m.get(k)) as T | undefined,
    put: async <T>(k: string, v: T) => void m.set(k, structuredClone(v)),
    list: async <T>(prefix: string) => new Map([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v) as T])),
  };
}

/** A resolution from the page: what David decided, in his words. */
export interface Resolution {
  outcome: TicketAnswer["outcome"];
  /** For set-aside: the kind of reason, from the page's Skip panel. */
  kind?: string;
  /**
   * A follow-up (a late reason, kept guidance): it adds to the answer it names (outcome and choice)
   * and is refused if the ticket's answer has since changed, so it can never reverse a newer answer.
   */
  update?: boolean;
  choice?: string;
  course?: string;
  reason?: string;
  conditions?: string;
  questions?: string[];
  instruction?: string;
  guidance?: string;
}

export function parseResolution(raw: unknown, d: Decision): Resolution {
  if (!raw || typeof raw !== "object") throw new AskError("the resolution must be an object");
  const b = raw as Record<string, unknown>;
  const outcomes = ["option", "other", "rejected", "ask-agent", "set-aside", "reopened", "resumed"] as const;
  const outcome = outcomes.find((o) => o === b.outcome);
  if (!outcome) throw new AskError(`outcome must be one of ${outcomes.join(", ")}`);
  const r: Resolution = { outcome };
  if (outcome === "option") {
    if (!d.options.some((o) => o.key === b.choice)) throw new AskError("choice is not an option of this decision");
    r.choice = b.choice as string;
  }
  // Long texts are clipped, never refused: a refused delivery would sit at the head of the page's outbox.
  const opt = (k: keyof Resolution, max: number) => {
    const t = str(b[k]);
    if (t) (r as unknown as Record<string, unknown>)[k] = t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };
  opt("course", MAX_REASON_CHARS);
  opt("reason", 1200);
  opt("conditions", 1200);
  opt("instruction", 1200);
  opt("guidance", 600);
  opt("kind", 20);
  if (b.update === true) r.update = true;
  if ((outcome === "other" || outcome === "rejected") && !r.course) throw new AskError("course is required for other and rejected");
  if (Array.isArray(b.questions)) r.questions = b.questions.map((q) => str(q).slice(0, MAX_REASON_CHARS)).filter(Boolean).slice(0, 8);
  return r;
}

const STATUS_OF: Record<Resolution["outcome"], TicketStatus> = {
  option: "answered",
  other: "answered",
  rejected: "answered",
  "ask-agent": "answered",
  "set-aside": "set-aside",
  reopened: "reopened",
  resumed: "open",
};

/** The ticket lifecycle over a KV store. Rules and facts live beside the tickets. */
export class LiveQueue {
  constructor(private kv: KV) {}

  /** The owner's onboarding run (docs/STAGE-10.md): one at a time; a new import replaces it. */
  async onboarding(): Promise<OnboardingRun | undefined> {
    return this.kv.get<OnboardingRun>("onboarding");
  }

  async setOnboarding(run: OnboardingRun): Promise<void> {
    await this.kv.put("onboarding", run);
  }

  /** The kept note, or undefined (then the distilled one applies), including once every line is deleted. */
  async note(): Promise<OwnerNote | undefined> {
    const n = await this.kv.get<OwnerNote | null>("note");
    return n && n.lines.length ? n : undefined;
  }

  /**
   * Keep a revised note: its lines join the facts (by id, so keeping twice adds nothing) and become the
   * owner's "how to work with me" note. Never rules: settling still needs a written rule.
   */
  async keepNote(run: OnboardingRun, facts: Fact[], note: OwnerNote, maxFacts: number, now = new Date()): Promise<{ ok: true; added: number } | { ok: false; error: string }> {
    const c = await this.context();
    const have = new Set(c.facts.map((f) => f.id));
    const fresh = facts.filter((f) => !have.has(f.id));
    if (c.facts.length + fresh.length > maxFacts) return { ok: false, error: `that would make ${c.facts.length + fresh.length} facts; the limit is ${maxFacts}` };
    await this.setContext(c.rules, [...c.facts, ...fresh]);
    await this.kv.put("note", note);
    await this.kv.put("onboarding", { ...run, kept_at: run.kept_at ?? now.toISOString() });
    return { ok: true, added: fresh.length };
  }

  /** What the owner's briefs may choose from (docs/STAGE-8.md): names and statuses only. */
  async catalog(): Promise<Catalog> {
    return (await this.kv.get<Catalog>("catalog")) ?? { servers: [], skills: [] };
  }

  async setCatalog(c: Catalog): Promise<void> {
    await this.kv.put("catalog", c);
  }

  async brief(id: string): Promise<Brief | undefined> {
    return this.kv.get<Brief>(`b:${id}`);
  }

  /** The newest first, at most MAX_BRIEFS_SHOWN. */
  async briefs(): Promise<Brief[]> {
    return [...(await this.kv.list<Brief>("b:")).values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, MAX_BRIEFS_SHOWN);
  }

  async addBrief(b: Brief): Promise<void> {
    await this.kv.put(`b:${b.id}`, b);
  }

  /** Copy command was pressed: the fields as copied replace the draft's, and the clock starts (again). */
  async dispatched(id: string, edits: BriefEdits, now = new Date()): Promise<Brief | undefined> {
    const b = await this.brief(id);
    if (!b) return undefined;
    const { ticked, ...rest } = edits;
    const next: Brief = { ...b, ...rest, dispatched_at: now.toISOString() };
    if (ticked) next.ticked = ticked.filter((i) => i < b.prerequisites.length);
    await this.kv.put(`b:${id}`, next);
    return next;
  }

  /**
   * The runner's launch record (docs/STAGE-9.md). "launching" is a reservation: refused, with the record
   * as it stands, unless the brief has none or its last launch failed. "running" and "failed" apply only
   * to the current reservation of the same attempt, so a late recovery or completion for an older attempt
   * changes nothing. One Durable Object serializes these, so a double tap launches once.
   */
  async launch(id: string, l: Launch): Promise<{ brief: Brief; ok: boolean } | undefined> {
    const b = await this.brief(id);
    if (!b) return undefined;
    const cur = b.launch;
    const ok = l.state === "launching" ? !cur || cur.state === "failed" : cur?.state === "launching" && cur.attempt === l.attempt && cur.repo === l.repo;
    if (!ok) return { brief: b, ok: false };
    const next: Brief = { ...b, launch: l.state === "launching" ? l : { ...l, at: cur!.at } };
    await this.kv.put(`b:${id}`, next);
    return { brief: next, ok: true };
  }

  /** "Walk me through it" steps for one item, replacing any earlier ones for it. */
  async walk(id: string, w: StoredWalk): Promise<Brief | undefined> {
    const b = await this.brief(id);
    if (!b) return undefined;
    const next: Brief = { ...b, walks: [...(b.walks ?? []).filter((x) => x.item !== w.item), w] };
    await this.kv.put(`b:${id}`, next);
    return next;
  }

  /** The session's report. A later report replaces an earlier one (a stop at the tripwire, then done). */
  async report(id: string, r: Report): Promise<Brief | undefined> {
    const b = await this.brief(id);
    if (!b) return undefined;
    const next: Brief = { ...b, report: r };
    await this.kv.put(`b:${id}`, next);
    return next;
  }

  /** An ask that named a brief: counted on it, if the brief exists. */
  private async countAsk(id: string): Promise<boolean> {
    const b = await this.brief(id);
    if (!b) return false;
    await this.kv.put(`b:${id}`, { ...b, asks: (b.asks ?? 0) + 1 });
    return true;
  }

  /** The owner's rules and facts, and a revision that changes with every save. */
  async context(): Promise<{ rules: Rule[]; facts: Fact[]; rev: number }> {
    return { rules: (await this.kv.get<Rule[]>("rules")) ?? OWNER_RULES, facts: (await this.kv.get<Fact[]>("facts")) ?? [], rev: (await this.kv.get<number>("rev")) ?? 0 };
  }

  /** Save (when given) and read the rules, facts and revision in one step, so routing uses a consistent snapshot. */
  async snapshot(rules?: Rule[], facts?: Fact[]): Promise<{ rules: Rule[]; facts: Fact[]; rev: number }> {
    if (rules && facts) await this.setContext(rules, facts);
    return this.context();
  }

  async setContext(rules: Rule[], facts: Fact[]): Promise<void> {
    const c = await this.context();
    if (JSON.stringify([c.rules, c.facts]) === JSON.stringify([rules, facts])) return;
    await this.kv.put("rules", rules);
    await this.kv.put("facts", facts);
    await this.kv.put("rev", c.rev + 1);
    // A kept onboarding note follows its facts: an edited line reads as edited, a deleted one is gone.
    const n = await this.kv.get<OwnerNote | null>("note");
    if (n?.fact_ids) {
      const byId = new Map(facts.map((f) => [f.id, f.text]));
      const ids = n.fact_ids.filter((id) => byId.has(id));
      await this.kv.put("note", { ...n, fact_ids: ids, lines: ids.map((id) => byId.get(id)!) });
    }
  }

  async get(id: string): Promise<Ticket | undefined> {
    return this.kv.get<Ticket>(`t:${id}`);
  }

  async all(): Promise<Ticket[]> {
    return [...(await this.kv.list<Ticket>("t:")).values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  /**
   * Store a newly routed ask. A settle route is answered by its rule at once, but only if the rules it
   * was routed under (`rev`) are still current; otherwise it waits for the owner.
   */
  async add(decision: Decision, card: Card, instruction: string, rev: number, now = new Date(), unrouted?: string, projectName?: string, brief?: string): Promise<Ticket> {
    const linked = brief ? await this.countAsk(brief) : false;
    const t: Ticket = {
      decision,
      card,
      status: "open",
      created_at: now.toISOString(),
      ...(unrouted ? { unrouted } : {}),
      ...(projectName ? { project_name: projectName } : {}),
      ...(linked ? { brief } : {}),
    };
    if (card.route === "settle") {
      if (rev === (await this.context()).rev) settle(t, instruction, now);
      else t.card = withheld(card, "your rules changed while Bug Me was routing it");
    }
    await this.kv.put(`t:${decision.id}`, t);
    return t;
  }

  /**
   * A re-route (a rule or fact changed): keep the new card. Settling now answers the ticket by rule,
   * only for a ticket nobody has touched (open, never reopened or resumed) and only if the rules it
   * was routed under are still current. An answered ticket is never changed.
   */
  async reroute(id: string, card: Card, instruction: string, rev: number, now = new Date()): Promise<Ticket | undefined> {
    const t = await this.get(id);
    if (!t || (t.status !== "open" && t.status !== "reopened")) return t;
    if (rev !== (await this.context()).rev) return t;
    if (card.route === "settle" && t.status === "open" && !t.answer) {
      t.card = card;
      settle(t, instruction, now);
    } else {
      // A reopened or resumed ticket stays the owner's, whatever the router now says.
      t.card = card.route === "settle" ? withheld(card, "you took this one back") : card;
    }
    await this.kv.put(`t:${id}`, t);
    return t;
  }

  /** David's resolution. Later resolutions of the same outcome add to it (a late reason, kept guidance). */
  async resolve(id: string, r: Resolution, now = new Date()): Promise<Ticket> {
    const t = await this.get(id);
    if (!t) throw new AskError("unknown ticket");
    const label = r.choice ? t.decision.options.find((o) => o.key === r.choice)?.label : undefined;
    const prev = t.answer && t.answer.outcome === r.outcome && t.answer.by === "owner" && t.answer.choice === r.choice ? t.answer : undefined;
    if (r.update && (!prev || t.status !== STATUS_OF[r.outcome])) throw new AskError("the answer this adds to has changed");
    const fresh: TicketAnswer = { outcome: r.outcome, by: "owner", at: now.toISOString() };
    const next: TicketAnswer = { ...(prev ?? fresh), at: now.toISOString() };
    for (const [k, v] of Object.entries({ choice: r.choice, label, course: r.course, reason: r.reason, conditions: r.conditions, questions: r.questions, instruction: r.instruction, guidance: r.guidance })) {
      if (v !== undefined && v !== "") (next as unknown as Record<string, unknown>)[k] = v;
    }
    t.answer = next;
    t.status = STATUS_OF[r.outcome];
    if (r.outcome === "set-aside") t.aside = { kind: r.kind ?? "info", reason: r.reason ?? "", instruction: r.instruction ?? "", at: now.toISOString() };
    if (r.outcome === "resumed") delete t.aside;
    // Undoing an automatic answer brings the ticket back to the owner: its card says so on every device.
    if (r.outcome === "reopened" && t.card.route === "settle") t.card = withheld(t.card, "you took this one back");
    await this.kv.put(`t:${id}`, t);
    return t;
  }

  /** Tickets the owner answered in the last day: the page keeps their follow-ups (a late reason, guidance) working. */
  async recentlyAnswered(now = new Date()): Promise<Ticket[]> {
    const since = now.getTime() - ANSWERED_KEPT_MS;
    return (await this.all()).filter((t) => t.status === "answered" && t.answer && Date.parse(t.answer.at) >= since);
  }

  /** What the page lists: open, reopened and set-aside tickets, and the most recent settled ones. */
  async shown(): Promise<Ticket[]> {
    const all = await this.all();
    const settled = all.filter((t) => t.status === "settled").slice(-SETTLED_SHOWN);
    // Set-aside tickets stay, so the page can list them and Resume them.
    return all.filter((t) => t.status === "open" || t.status === "reopened" || t.status === "set-aside" || settled.includes(t));
  }
}

/** A settle card the owner keeps: brought as a quick check instead, with the reason, the model's own route kept. */
function withheld(card: Card, why: string): Card {
  return { ...card, route: "check_in", settle_option: "", adjusted: `Bug Me would have settled this, but ${why}.` };
}

function settle(t: Ticket, instruction: string, now: Date): void {
  const label = t.decision.options.find((o) => o.key === t.card.settle_option)?.label;
  t.status = "settled";
  t.answer = { outcome: "option", by: "rule", choice: t.card.settle_option, label, rule: t.card.clearing_rule, instruction, at: now.toISOString() };
}

/** What the asking session is told about a ticket: the MCP server returns this as is. */
export function reply(t: Ticket): Record<string, unknown> {
  const a = t.answer;
  if (t.status === "open") return { status: "pending", ticket: t.decision.id, route: t.card.route, why: t.card.why_here };
  if (t.status === "reopened") {
    return {
      status: "reopened",
      ticket: t.decision.id,
      note: "David undid the automatic answer. If you already acted on it and it is cheap to reverse, reverse it; then wait and check back.",
    };
  }
  if (t.status === "settled") return { status: "settled", ticket: t.decision.id, choice: a?.choice, label: a?.label, rule: a?.rule, instruction: a?.instruction };
  if (t.status === "set-aside") return { status: "set-aside", ticket: t.decision.id, reason: a?.reason, instruction: a?.instruction };
  const { by: _by, at: _at, ...rest } = a ?? ({} as TicketAnswer);
  return { status: "answered", ticket: t.decision.id, ...rest };
}

/** Minutes since a ticket was asked, for the card's "waiting" line. */
export function waitingMinutes(t: Ticket, now = new Date()): number {
  return Math.max(0, Math.round((now.getTime() - Date.parse(t.created_at)) / 60000));
}
