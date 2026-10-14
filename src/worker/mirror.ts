// Hooks into Bug Me (docs/STAGE-10.md, 10d): what the hook script (mcp/bugme-hook.mjs) posts, checked
// and turned into decisions and answers. Mirror only: a mirrored question is shown on /me, briefed and
// routed, and answered in the session; nothing here can answer it.
//
// The shapes follow payloads captured from Claude Code 2.1.300 (fixtures/hooks, sanitized):
//   - AskUserQuestion's tool_input is { questions: [{ question, header, options: [{ label, description }],
//     multiSelect }] }; PostToolUse adds `answers`, keyed by question text. A multi-select answer joins
//     the labels with ", "; a typed answer is the typed text itself.
//   - ExitPlanMode's PostToolUse fires only when the plan is approved. A rejected plan or a dismissed
//     question fires neither PostToolUse nor PostToolUseFailure, so those close on Stop or SessionEnd.
// Kept free of Workers-only imports, so the unit tests run it in Node.

import { MIRROR_MAX_OPTIONS, MIRROR_MAX_QUESTIONS, MIRROR_TEST_DELAY_MAX_MS } from "../shared/constants";
import type { Decision, MirrorAnswer, MirrorView } from "../shared/types";
import { AskError, UNKNOWN_COST_USD, projectId } from "./live";

export interface MirrorQuestion {
  question: string;
  header: string;
  multi: boolean;
  options: { label: string; description: string }[];
}

export type MirrorEvent =
  | {
      event: "pre" | "post";
      session: string;
      toolUse: string;
      kind: "ask" | "plan";
      project: string;
      /** Empty for a plan: its text never leaves the session. */
      questions: MirrorQuestion[];
      /** PostToolUse's answers, by question text. */
      answers: Record<string, string>;
      /** Tests only, honored only on the fake model: hold routing this long, as a slow model call would. */
      testDelayMs?: number;
      /** When the hook saw the event (ms), so events that arrive out of order are still put in order. */
      at: number;
    }
  | { event: "stop" | "end"; session: string; at: number };

export type QuestionEvent = Extract<MirrorEvent, { event: "pre" | "post" }>;
export const isQuestionEvent = (ev: MirrorEvent): ev is QuestionEvent => ev.event === "pre" || ev.event === "post";

/** What a ticket keeps about its mirror: the page's view plus the correlation the hook sends. */
export interface MirrorRecord extends MirrorView {
  session: string;
  tool_use: string;
  /** When the hook saw the question (ms): a Stop or SessionEnd stamped later closes it, one stamped earlier doesn't. */
  asked_at: number;
  test_delay_ms?: number;
}

const MAX_QUESTION_CHARS = 600;
const MAX_HEADER_CHARS = 40;
const MAX_LABEL_CHARS = 120;
const MAX_DESCRIPTION_CHARS = 300;
const MAX_ANSWER_CHARS = 1200;
const MAX_PROJECT_CHARS = 60;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/** The plan approval's card: the question and its two outcomes, never the plan. */
export const PLAN_QUESTION = "Approve this session's plan?";
export const PLAN_OPTIONS = ["Approve", "Keep planning"];

const str = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
function bounded(v: unknown, max: number, field: string, required = true, collapse = true): string {
  // Questions and labels keep their inner spacing: answers name them exactly, so they must match exactly.
  const t = collapse ? str(v) : typeof v === "string" ? v.trim() : "";
  if (required && !t) throw new AskError(`${field} is required`);
  if (t.length > max) throw new AskError(`${field} is longer than ${max} characters`);
  return t;
}
function id(v: unknown, field: string): string {
  if (typeof v !== "string" || !ID_RE.test(v)) throw new AskError(`${field} is missing or malformed`);
  return v;
}

/** Check one event from the hook. Anything malformed is refused (the hook ignores the refusal and exits 0). */
export function parseMirrorEvent(raw: unknown, allowTestDelay = false, now = Date.now()): MirrorEvent {
  if (!raw || typeof raw !== "object") throw new AskError("the event must be an object");
  const b = raw as Record<string, unknown>;
  const session = id(b.session_id, "session_id");
  // The hook stamps each event as it runs (async hooks can deliver out of order); without a usable stamp,
  // arrival time stands in.
  const at = typeof b.at === "number" && Number.isFinite(b.at) && b.at > 0 ? b.at : now;
  if (b.event === "stop" || b.event === "end") return { event: b.event, session, at };
  if (b.event !== "pre" && b.event !== "post") throw new AskError("event must be pre, post, stop or end");
  const toolUse = id(b.tool_use_id, "tool_use_id");
  const kind = b.tool === "AskUserQuestion" ? "ask" : b.tool === "ExitPlanMode" ? "plan" : null;
  if (!kind) throw new AskError("tool must be AskUserQuestion or ExitPlanMode");
  const project = bounded(b.project ?? "", MAX_PROJECT_CHARS, "project", false) || "Other";
  let questions: MirrorQuestion[] = [];
  if (kind === "ask") {
    if (!Array.isArray(b.questions) || b.questions.length < 1 || b.questions.length > MIRROR_MAX_QUESTIONS) {
      throw new AskError(`questions must be a list of 1 to ${MIRROR_MAX_QUESTIONS}`);
    }
    questions = b.questions.map((q, i) => {
      const x = (q && typeof q === "object" ? q : {}) as Record<string, unknown>;
      if (!Array.isArray(x.options) || x.options.length < 1 || x.options.length > MIRROR_MAX_OPTIONS) {
        throw new AskError(`questions[${i}].options must be a list of 1 to ${MIRROR_MAX_OPTIONS}`);
      }
      return {
        question: bounded(x.question, MAX_QUESTION_CHARS, `questions[${i}].question`, true, false),
        header: bounded(x.header ?? "", MAX_HEADER_CHARS, `questions[${i}].header`, false),
        multi: x.multiSelect === true,
        options: x.options.map((o, j) => {
          const y = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
          return {
            label: bounded(y.label, MAX_LABEL_CHARS, `questions[${i}].options[${j}].label`, true, false),
            description: bounded(y.description ?? "", MAX_DESCRIPTION_CHARS, `questions[${i}].options[${j}].description`, false),
          };
        }),
      };
    });
  }
  const answers: Record<string, string> = {};
  if (b.answers && typeof b.answers === "object") {
    for (const [k, v] of Object.entries(b.answers as Record<string, unknown>)) {
      // Answers are kept exactly (trimmed), so a typed answer survives as written; long ones are clipped.
      if (typeof v === "string") answers[k.trim()] = v.trim().slice(0, MAX_ANSWER_CHARS);
    }
  }
  const delay = Number(b.test_delay_ms);
  const testDelayMs = allowTestDelay && Number.isFinite(delay) && delay > 0 ? Math.min(delay, MIRROR_TEST_DELAY_MAX_MS) : undefined;
  return { event: b.event, session, toolUse, kind, project, questions, answers, at, ...(testDelayMs ? { testDelayMs } : {}) };
}

/**
 * A mirrored question's ticket id: the same for the same session, tool call and question, so a hook
 * that delivers twice (or a PostToolUse whose PreToolUse was lost) lands on the same ticket.
 */
export async function mirrorId(session: string, toolUse: string, index: number): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${session}\n${toolUse}\n${index}`)));
  return `t-${Array.from(d.slice(0, 10), (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/** How many questions an event asks: a plan approval is one. */
export function questionCount(ev: QuestionEvent): number {
  return ev.kind === "plan" ? 1 : ev.questions.length;
}

/**
 * One question of a mirrored call as a Decision in the simulation's shape, so routing and the card run
 * unchanged. Every option counts as irreversible and of unknown cost: the session declares neither, so
 * nothing mirrored is ever eligible to settle, even in the shadow.
 */
export function decisionFromMirror(ev: QuestionEvent, index: number, ticket: string): Decision {
  const keys = "ABCD";
  const plan = ev.kind === "plan";
  const q: MirrorQuestion = plan
    ? { question: PLAN_QUESTION, header: "Plan", multi: false, options: PLAN_OPTIONS.map((label) => ({ label, description: "" })) }
    : ev.questions[index];
  const options = q.options.map((o, i) => ({ key: keys[i], label: o.label, ...(o.description ? { description: o.description } : {}) }));
  const bounds: Decision["bounds"] = Object.fromEntries(options.map((o) => [o.key, { reversible: "no" as const, cost_usd: UNKNOWN_COST_USD }]));
  const others = plan ? [] : ev.questions.filter((_, i) => i !== index).map((x) => x.question);
  const context = plan
    ? "A Claude Code session finished planning and asked to go ahead (ExitPlanMode). The plan itself stays in the session."
    : [
        `Asked in a Claude Code session (AskUserQuestion)${q.multi ? "; any number of options may be picked" : ""}; the person may also type their own answer.`,
        others.length ? `Asked in the same breath: ${others.map((x) => `“${x}”`).join(" ")}` : "",
      ]
        .filter(Boolean)
        .join(" ");
  return {
    id: ticket,
    category: "Live",
    project: projectId(ev.project),
    agent: [`session ${ev.session.slice(0, 8)}`],
    waiting_minutes: 0,
    unblocks: 1,
    question: q.question,
    options,
    recommended: options[0].key,
    no_recommendation: true,
    context,
    bounds,
    tags: [],
  };
}

/** The page's view of a new mirror, before routing or an answer. */
export function newMirror(ev: QuestionEvent, index: number): MirrorRecord {
  const q = ev.kind === "ask" ? ev.questions[index] : undefined;
  return {
    kind: ev.kind,
    state: "pending",
    ...(q?.header ? { header: q.header } : {}),
    multi: q?.multi ?? false,
    index,
    of: questionCount(ev),
    routed: false,
    session: ev.session,
    tool_use: ev.toolUse,
    asked_at: ev.at,
    ...(ev.testDelayMs ? { test_delay_ms: ev.testDelayMs } : {}),
  };
}

/**
 * The session's answer to one question, from PostToolUse. A plan's PostToolUse means it was approved.
 * A multi-select answer is split back into labels (a label may itself hold ", ", so the longest match
 * wins); whatever matches no label is the typed part. Undefined when the event carries no answer for it.
 */
export function answerFromMirror(ev: QuestionEvent, index: number, d: Decision): MirrorAnswer | undefined {
  if (ev.kind === "plan") return { text: PLAN_OPTIONS[0], keys: ["A"] };
  const raw = ev.answers[ev.questions[index].question];
  if (raw === undefined) return undefined;
  const byLabel = new Map(d.options.map((o) => [o.label, o.key]));
  const exact = byLabel.get(raw);
  if (exact) return { text: raw, keys: [exact] };
  if (!ev.questions[index].multi) return { text: raw, keys: [], ...(raw ? { typed: raw } : {}) };
  const parts = raw.split(", ");
  const keys: string[] = [];
  const typed: string[] = [];
  for (let i = 0; i < parts.length; ) {
    let j = parts.length;
    while (j > i && !byLabel.has(parts.slice(i, j).join(", "))) j--;
    if (j > i) {
      keys.push(byLabel.get(parts.slice(i, j).join(", "))!);
      i = j;
    } else {
      typed.push(parts[i]);
      i++;
    }
  }
  const ordered = d.options.map((o) => o.key).filter((k) => keys.includes(k));
  return { text: raw, keys: ordered, ...(typed.length ? { typed: typed.join(", ") } : {}) };
}

/** The page's view of a ticket's mirror: the correlation and the test knob stay on the server. */
export function mirrorView(m: MirrorRecord): MirrorView {
  const { session: _s, tool_use: _t, test_delay_ms: _d, asked_at: _a, ...view } = m;
  return view;
}
