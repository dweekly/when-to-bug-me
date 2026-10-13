// Dispatch (docs/STAGE-8.md): a rough task becomes a brief and a ready `claude` command. The model drafts
// the brief inside enums drawn from the catalog; code checks it, decides where it runs, adds the
// prerequisites the catalog implies, and builds the command and the session's opening prompt.

import { verifyQuote } from "./route";
import type { Fact, Rule } from "./types";

/** The models a brief may choose (ids as the Claude CLI's --model takes them). */
export const DISPATCH_MODELS = [
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5" },
] as const;
/** The CLI's --effort levels (`claude --help`, 2.1.296). */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** The --permission-mode values a brief may set. Never bypassPermissions or dontAsk. */
export const PERMISSION_MODES = ["plan", "manual", "acceptEdits", "auto"] as const;
export const STAGES = ["prototype", "mvp", "product"] as const;
export const LEVELS = ["low", "medium", "high"] as const;
export const OUTCOMES = ["done", "stopped at tripwire", "partial", "abandoned"] as const;
export const SCOPES = ["as briefed", "smaller", "bigger"] as const;
export const SERVER_STATUSES = ["connected", "needs authentication", "failed", "not configured"] as const;

/** Stop and ask at this multiple of the estimate. Jordan's R10 and David's own rule: "past twice its time budget". */
export const TRIPWIRE_MULTIPLE = 2;
export const MAX_TASK_CHARS = 2000;
export const MAX_ANSWERS_CHARS = 1500;
export const MAX_SERVERS = 80;
export const MAX_SKILLS = 120;
/** Caps on the brief's lists, applied in code (the structured-output schema carries only enums). */
const CAP = { questions: 3, done: 3, out_of_scope: 4, context: 5, guidance: 4, prerequisites: 4, check_ins: 4, tools: 12, skills: 4 };

/** Bug Me's own MCP server: every owner brief needs it (ask_bug_me, report_to_bug_me), so it is never turned off. */
export const BUGME_PREFIX = "mcp__bugme";
const PREFIX_RE = /^mcp__[A-Za-z0-9_-]{1,80}$/;
const SKILL_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

export type Model = (typeof DISPATCH_MODELS)[number]["id"];
export type Effort = (typeof EFFORTS)[number];
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type Stage = (typeof STAGES)[number];
export type Level = (typeof LEVELS)[number];
export type Outcome = (typeof OUTCOMES)[number];
export type Scope = (typeof SCOPES)[number];
export type ServerStatus = (typeof SERVER_STATUSES)[number];

export interface Server {
  /** As `claude mcp list` names it ("claude.ai Gmail"). Display only; never reaches the shell. */
  name: string;
  /** The tool-name prefix a session sees ("mcp__claude_ai_Gmail"). */
  prefix: string;
  status: ServerStatus;
}
export interface Catalog {
  servers: Server[];
  skills: string[];
}

/** What the model drafts, after code's checks. */
export interface BriefDraft {
  headline: string;
  goal: string;
  why: string;
  questions: string[];
  stage: Stage;
  done: string[];
  out_of_scope: string[];
  estimate_minutes: number;
  budget_usd: number;
  model: Model;
  effort: Effort;
  permission_mode: PermissionMode;
  sensitivity: Level;
  sensitivity_reason: string;
  urgency: Level;
  urgency_reason: string;
  tools_off: string[];
  tools_needed: string[];
  skills: string[];
  context: string[];
  /** The person's rules and facts that bear on the task, each the exact source text. */
  guidance: string[];
  prerequisites: { what: string; why: string }[];
  check_ins: string[];
}

export interface Report {
  outcome: Outcome;
  scope: Scope;
  summary: string;
  cost_usd?: number;
  at: string;
}

/** A brief as stored and shown: the draft plus what code decided. */
export interface Brief extends BriefDraft {
  id: string;
  task: string;
  answers?: string;
  where: "cloud" | "local";
  where_reason: string;
  created_at: string;
  /** When Copy command was last pressed (the fields as copied replace the draft's). Owner only. */
  dispatched_at?: string;
  report?: Report;
  /** Asks made through ask_bug_me carrying this brief's id. Owner only. */
  asks?: number;
}

export class DispatchError extends Error {}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const strs = (v: unknown, cap: number, max = 200) => (Array.isArray(v) ? v.map((x) => str(x, max)).filter(Boolean).slice(0, cap) : []);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], field: string): T => {
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  throw new DispatchError(`${field} must be one of ${allowed.join(", ")}`);
};
const num = (v: unknown, lo: number, hi: number, field: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) throw new DispatchError(`${field} must be a number from ${lo} to ${hi}`);
  return v;
};

/** Claude Code's tool prefix for a server name: every character outside [A-Za-z0-9_-] becomes "_". */
export function toolPrefix(name: string): string {
  return `mcp__${name.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** Validate a catalog as it comes in. A name or prefix that fails its pattern is rejected, not cleaned. */
export function parseCatalog(raw: unknown): Catalog {
  if (!raw || typeof raw !== "object") throw new DispatchError("catalog is not an object");
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.servers) || o.servers.length > MAX_SERVERS) throw new DispatchError(`servers must be a list of at most ${MAX_SERVERS}`);
  if (!Array.isArray(o.skills) || o.skills.length > MAX_SKILLS) throw new DispatchError(`skills must be a list of at most ${MAX_SKILLS}`);
  const servers = o.servers.map((s, i): Server => {
    const x = (s ?? {}) as Record<string, unknown>;
    const name = typeof x.name === "string" ? x.name.trim() : "";
    if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name)) throw new DispatchError(`servers[${i}].name is not a short printable name`);
    const prefix = typeof x.prefix === "string" ? x.prefix : "";
    if (!PREFIX_RE.test(prefix) || prefix !== toolPrefix(name)) throw new DispatchError(`servers[${i}].prefix is not the tool prefix of its name`);
    return { name, prefix, status: oneOf(x.status, SERVER_STATUSES, `servers[${i}].status`) };
  });
  const skills = o.skills.map((s, i) => {
    if (typeof s !== "string" || !SKILL_RE.test(s)) throw new DispatchError(`skills[${i}] is not a plain skill name`);
    return s;
  });
  if (new Set(servers.map((s) => s.prefix)).size !== servers.length) throw new DispatchError("two servers share a tool prefix");
  return { servers, skills: [...new Set(skills)] };
}

/** The draft's JSON schema: every field that names a model, effort, mode, tool or skill is an enum of what exists. */
export function dispatchSchema(c: Catalog) {
  const s = { type: "string" } as const;
  const list = { type: "array", items: s } as const;
  const enumList = (values: string[]) => (values.length ? { type: "array", items: { type: "string", enum: values } } : list);
  const level = { type: "string", enum: [...LEVELS] } as const;
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "headline", "goal", "why", "questions", "stage", "done", "out_of_scope", "estimate_minutes", "budget_usd", "model", "effort",
      "permission_mode", "sensitivity", "sensitivity_reason", "urgency", "urgency_reason", "tools_off", "tools_needed", "skills",
      "context", "guidance", "prerequisites", "check_ins",
    ],
    properties: {
      headline: s,
      goal: s,
      why: s,
      questions: list,
      stage: { type: "string", enum: [...STAGES] },
      done: list,
      out_of_scope: list,
      estimate_minutes: { type: "number" },
      budget_usd: { type: "number" },
      model: { type: "string", enum: DISPATCH_MODELS.map((m) => m.id) },
      effort: { type: "string", enum: [...EFFORTS] },
      permission_mode: { type: "string", enum: [...PERMISSION_MODES] },
      sensitivity: level,
      sensitivity_reason: s,
      urgency: level,
      urgency_reason: s,
      tools_off: enumList(c.servers.map((x) => x.prefix)),
      tools_needed: enumList(c.servers.map((x) => x.prefix)),
      skills: enumList(c.skills),
      context: list,
      guidance: list,
      prerequisites: { type: "array", items: { type: "object", additionalProperties: false, required: ["what", "why"], properties: { what: s, why: s } } },
      check_ins: list,
    },
  } as const;
}

/**
 * Check a draft: enums against the catalog (a name not in it is dropped), lists capped, guidance kept
 * only where it quotes a current rule or fact (the whole source text is kept). A draft whose task the
 * model couldn't size (no headline or goal) is rejected.
 */
export function parseBriefDraft(raw: unknown, c: Catalog, rules: Rule[], facts: Fact[]): BriefDraft {
  if (!raw || typeof raw !== "object") throw new DispatchError("not an object");
  const o = raw as Record<string, unknown>;
  const headline = str(o.headline, 80);
  const goal = str(o.goal, 300);
  if (!headline || !goal) throw new DispatchError("headline and goal are required");
  const prefixes = new Set(c.servers.map((s) => s.prefix));
  const skills = new Set(c.skills);
  const known = (v: unknown, set: Set<string>, cap: number) => [...new Set(strs(v, 50, 100).filter((x) => set.has(x)))].slice(0, cap);
  const record = [...rules.map((r) => r.text), ...facts.map((f) => f.text)];
  const guidance = [...new Set(strs(o.guidance, 10, 400).map((q) => verifyQuote(q, record)).filter(Boolean))].slice(0, CAP.guidance);
  const prerequisites = (Array.isArray(o.prerequisites) ? o.prerequisites : [])
    .map((p) => ({ what: str((p as Record<string, unknown>)?.what, 160), why: str((p as Record<string, unknown>)?.why, 200) }))
    .filter((p) => p.what)
    .slice(0, CAP.prerequisites);
  return {
    headline,
    goal,
    why: str(o.why, 300),
    questions: strs(o.questions, CAP.questions, 240),
    stage: oneOf(o.stage, STAGES, "stage"),
    done: strs(o.done, CAP.done),
    out_of_scope: strs(o.out_of_scope, CAP.out_of_scope),
    estimate_minutes: Math.round(num(o.estimate_minutes, 1, 60 * 24 * 7, "estimate_minutes")),
    budget_usd: Math.round(num(o.budget_usd, 0, 10_000, "budget_usd") * 100) / 100,
    model: oneOf(o.model, DISPATCH_MODELS.map((m) => m.id), "model"),
    effort: oneOf(o.effort, EFFORTS, "effort"),
    permission_mode: oneOf(o.permission_mode, PERMISSION_MODES, "permission_mode"),
    sensitivity: oneOf(o.sensitivity, LEVELS, "sensitivity"),
    sensitivity_reason: str(o.sensitivity_reason, 200),
    urgency: oneOf(o.urgency, LEVELS, "urgency"),
    urgency_reason: str(o.urgency_reason, 200),
    tools_off: known(o.tools_off, prefixes, CAP.tools),
    tools_needed: known(o.tools_needed, prefixes, CAP.tools),
    skills: known(o.skills, skills, CAP.skills),
    context: strs(o.context, CAP.context),
    guidance,
    prerequisites,
    check_ins: strs(o.check_ins, CAP.check_ins),
  };
}

/** Where a task runs, from its sensitivity and urgency: code's table, not the model's call. */
export function runWhere(sensitivity: Level, urgency: Level): { where: "cloud" | "local"; reason: string; checkIn?: string } {
  if (sensitivity === "high" && urgency === "low") {
    return { where: "local", reason: "Sensitive and not urgent: a local model keeps the data on your machine. (Recommended only; a local route isn't wired yet.)" };
  }
  if (sensitivity === "high") {
    return { where: "cloud", reason: "Sensitive, but it can't wait for a local run.", checkIn: "Before anything sensitive leaves this machine, ask with what would be sent and why." };
  }
  return { where: "cloud", reason: "" };
}

/**
 * The brief as stored: code decides where it runs, keeps Bug Me's server on, and turns each needed tool
 * that isn't connected into a prerequisite. `owner` adds Bug Me's own server as a requirement.
 */
export function finishBrief(d: BriefDraft, c: Catalog, meta: { id: string; task: string; answers?: string; now: Date; owner: boolean }): Brief {
  const w = runWhere(d.sensitivity, d.urgency);
  const byPrefix = new Map(c.servers.map((s) => [s.prefix, s]));
  const tools_off = d.tools_off.filter((p) => p !== BUGME_PREFIX && !d.tools_needed.includes(p));
  const auto: { what: string; why: string }[] = [];
  if (meta.owner) {
    const bugme = byPrefix.get(BUGME_PREFIX);
    if (bugme?.status !== "connected") auto.push({ what: "Connect Bug Me's MCP server", why: bugme ? `It's ${bugme.status}; the session asks and reports through it.` : "It isn't in your synced catalog; the session asks and reports through it." });
  }
  for (const p of d.tools_needed) {
    const s = byPrefix.get(p);
    if (s && s.status !== "connected") auto.push({ what: `Connect ${s.name}`, why: `The task needs it, and it's ${s.status}.` });
  }
  const seen = new Set(auto.map((a) => a.what.toLowerCase()));
  const prerequisites = [...auto, ...d.prerequisites.filter((p) => !seen.has(p.what.toLowerCase()))];
  const check_ins = w.checkIn && !d.check_ins.includes(w.checkIn) ? [w.checkIn, ...d.check_ins] : d.check_ins;
  return {
    ...d,
    tools_off,
    prerequisites,
    check_ins,
    id: meta.id,
    task: meta.task,
    ...(meta.answers ? { answers: meta.answers } : {}),
    where: w.where,
    where_reason: w.reason,
    created_at: meta.now.toISOString(),
  };
}

/** The fields a person may change before copying, checked against the catalog. */
export interface BriefEdits {
  model: Model;
  effort: Effort;
  permission_mode: PermissionMode;
  estimate_minutes: number;
  budget_usd: number;
  tools_off: string[];
}

export function parseEdits(raw: unknown, c: Catalog): BriefEdits {
  if (!raw || typeof raw !== "object") throw new DispatchError("edits are not an object");
  const o = raw as Record<string, unknown>;
  const prefixes = new Set(c.servers.map((s) => s.prefix));
  if (!Array.isArray(o.tools_off) || o.tools_off.some((p) => typeof p !== "string" || !prefixes.has(p) || p === BUGME_PREFIX)) {
    throw new DispatchError("tools_off must name servers in the catalog, other than Bug Me's");
  }
  return {
    model: oneOf(o.model, DISPATCH_MODELS.map((m) => m.id), "model"),
    effort: oneOf(o.effort, EFFORTS, "effort"),
    permission_mode: oneOf(o.permission_mode, PERMISSION_MODES, "permission_mode"),
    estimate_minutes: Math.round(num(o.estimate_minutes, 1, 60 * 24 * 7, "estimate_minutes")),
    budget_usd: Math.round(num(o.budget_usd, 0, 10_000, "budget_usd") * 100) / 100,
    tools_off: [...new Set(o.tools_off as string[])].slice(0, CAP.tools),
  };
}

export function parseReport(raw: unknown, now = new Date()): Report {
  if (!raw || typeof raw !== "object") throw new DispatchError("report is not an object");
  const o = raw as Record<string, unknown>;
  const summary = str(o.summary, 600);
  if (!summary) throw new DispatchError("summary is required");
  const cost = o.cost_usd === undefined || o.cost_usd === null ? undefined : num(o.cost_usd, 0, 10_000, "cost_usd");
  return { outcome: oneOf(o.outcome, OUTCOMES, "outcome"), scope: oneOf(o.scope, SCOPES, "scope"), summary, ...(cost === undefined ? {} : { cost_usd: cost }), at: now.toISOString() };
}

export const tripwireMinutes = (b: Pick<Brief, "estimate_minutes">) => b.estimate_minutes * TRIPWIRE_MULTIPLE;
const modelLabel = (id: string) => DISPATCH_MODELS.find((m) => m.id === id)?.label ?? id;
const bullets = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");

/** The session's opening prompt: everything it needs to work at the briefed size, and to come back when it isn't. */
export function briefText(b: Brief, c: Catalog): string {
  const name = (p: string) => c.servers.find((s) => s.prefix === p)?.name ?? p;
  const parts = [
    `Bug Me brief ${b.id}: ${b.headline}`,
    `Goal: ${b.goal}${b.why ? `\nWhy: ${b.why} (If a different approach serves this better, say so.)` : ""}`,
    `Stage: ${b.stage}. Build to this stage and no further.`,
    b.done.length ? `Done when:\n${bullets(b.done)}` : "",
    b.out_of_scope.length ? `Out of scope (don't build these; if one seems necessary, ask first):\n${bullets(b.out_of_scope)}` : "",
    `Time: about ${b.estimate_minutes} minutes. Run \`date\` now and note the time. At ${tripwireMinutes(b)} minutes (${TRIPWIRE_MULTIPLE}× the estimate), stop and use ask_bug_me before going on: say what's done, what's left, and offer smaller versions. Don't expand the scope to finish.`,
    `Money: about $${b.budget_usd.toFixed(2)} of model spend. A guide only; you can't see your spend, so use the time tripwire.`,
    b.context.length ? `Context:\n${bullets(b.context)}` : "",
    b.guidance.length ? `The person's own rules that apply:\n${bullets(b.guidance.map((g) => `"${g}"`))}` : "",
    b.tools_needed.length ? `Tools you'll need: ${b.tools_needed.map(name).join(", ")}.` : "",
    b.skills.length ? `Skills worth loading: ${b.skills.join(", ")}.` : "",
    b.check_ins.length ? `Ask with ask_bug_me (pass brief "${b.id}") before:\n${bullets(b.check_ins)}` : `Ask with ask_bug_me (pass brief "${b.id}") for anything that is the person's to decide.`,
    `When you finish or stop, call report_to_bug_me with brief "${b.id}": the outcome, whether the scope stayed as briefed, and a two-sentence summary.`,
  ];
  return parts.filter(Boolean).join("\n\n");
}

/** POSIX single-quoting: the value comes out as one literal argument, whatever it contains. */
export function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** A heredoc delimiter that occurs nowhere in the text, so the text can't end the heredoc early. */
function delimiterFor(text: string): string {
  for (let n = 0; ; n++) {
    const d = n ? `BRIEF_${n}` : "BRIEF";
    if (!text.split("\n").some((l) => l.includes(d))) return d;
  }
}

/** The command that starts the session: every argument quoted, the brief inside a quoted heredoc. */
export function buildCommand(b: Brief, c: Catalog): string {
  const text = briefText(b, c);
  const d = delimiterFor(text);
  const args = ["claude", "--model", shellQuote(b.model), "--effort", shellQuote(b.effort), "--permission-mode", shellQuote(b.permission_mode)];
  for (const p of b.tools_off) {
    if (!PREFIX_RE.test(p)) throw new DispatchError("a tool prefix failed its pattern");
    args.push("--disallowedTools", shellQuote(p));
  }
  return `${args.join(" ")} "$(cat <<'${d}'\n${text}\n${d}\n)"`;
}

/** One line for the brief card and the list: stage · ~N min · $X · tripwire. */
export function sizeLine(b: Brief): string {
  return `${b.stage} · ~${b.estimate_minutes} min · $${b.budget_usd.toFixed(2)} · stop at ${tripwireMinutes(b)} min`;
}

export const whereLine = (b: Brief) => `${modelLabel(b.model)} · ${b.effort} effort · ${b.permission_mode} · ${b.where === "local" ? "run locally" : "cloud"}`;
