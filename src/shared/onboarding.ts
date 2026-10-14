// Onboarding (docs/STAGE-10.md): Bug Me reads a person's past decisions, drafts their "how to work
// with me" note, interviews them about what it saw, and revises the note. The model writes; code checks:
// every line cites decisions that exist, limits hold after revision too, and history evidence is kept
// apart from what the person said in the interview.

export class OnboardingError extends Error {}

/** One past decision, as onboarding reads it. `answer` is an option key, or null when the person typed one. */
export interface HistoryItem {
  id: string;
  project: string;
  days_ago: number;
  question: string;
  options: { key: string; label: string }[];
  recommended?: string;
  answer: string | null;
  typed?: string;
  reason?: string;
  /** How long the question waited on screen before the answer. */
  seconds?: number;
}

export const NOTE_KINDS = ["preference", "rule-like", "contradiction"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export interface NoteLine {
  id: string;
  text: string;
  kind: NoteKind;
  /** History ids this line rests on: never empty, each one real. */
  cites: string[];
}

export interface InterviewQuestion {
  id: string;
  text: string;
  /** The note lines it asks about. */
  about: string[];
}

export const CHANGES = ["kept", "changed", "added", "removed"] as const;
export type Change = (typeof CHANGES)[number];

/** A line of the revised note: what the interview did to it, and why, in the person's words where they gave them. */
export interface RevisedLine extends NoteLine {
  change: Change;
  /** For changed, added or removed lines: the interview answer behind it (a question id). */
  because?: string;
  why?: string;
}

export const MAX_NOTE_LINES = 8;
export const MAX_LINE_CHARS = 200;
export const MAX_QUESTIONS = 3;
export const MAX_QUESTION_CHARS = 280;
export const MAX_ANSWER_CHARS = 1200;
const ID_RE = /^[a-z0-9-]{1,24}$/;

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Parse one history item (the fixture, or rows an import brings). */
export function parseHistoryItem(raw: unknown): HistoryItem {
  const o = (raw ?? {}) as Record<string, unknown>;
  const id = str(o.id, 24);
  if (!ID_RE.test(id)) throw new OnboardingError("a history item needs an id");
  const question = str(o.question, 600);
  if (!question) throw new OnboardingError(`${id}: no question`);
  const options = Array.isArray(o.options)
    ? o.options.slice(0, 6).map((x) => {
        const p = (x ?? {}) as Record<string, unknown>;
        return { key: str(p.key, 8), label: str(p.label, 200) };
      }).filter((x) => x.key && x.label)
    : [];
  const typedAnswer = o.answer === "typed" || o.answer === null;
  const answer = typedAnswer ? null : str(o.answer, 8) || null;
  if (answer && !options.some((x) => x.key === answer)) throw new OnboardingError(`${id}: the answer isn't one of its options`);
  const typed = str(o.typed, 600);
  if (!answer && !typed) throw new OnboardingError(`${id}: no answer`);
  return {
    id,
    project: str(o.project, 40) || "other",
    days_ago: typeof o.days_ago === "number" && o.days_ago >= 0 ? Math.round(o.days_ago) : 0,
    question,
    options,
    ...(typeof o.recommended === "string" && options.some((x) => x.key === o.recommended) ? { recommended: o.recommended } : {}),
    answer,
    ...(typed ? { typed } : {}),
    ...(str(o.reason, 600) ? { reason: str(o.reason, 600) } : {}),
    ...(typeof o.seconds === "number" && o.seconds >= 0 ? { seconds: Math.round(o.seconds) } : {}),
  };
}

export function parseHistory(raw: unknown, max = 200): HistoryItem[] {
  const items = Array.isArray(raw) ? raw.map(parseHistoryItem) : [];
  const seen = new Set<string>();
  const out = items.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true))).slice(0, max);
  if (!out.length) throw new OnboardingError("no history to read");
  return out;
}

const lineSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "text", "kind", "cites"],
  properties: {
    id: { type: "string", description: "Short id: n1, n2, …" },
    text: { type: "string" },
    kind: { type: "string", enum: [...NOTE_KINDS] },
    cites: { type: "array", items: { type: "string" } },
  },
} as const;

export const NOTE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["lines"],
  properties: { lines: { type: "array", items: lineSchema } },
} as const;

export const INTERVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "text", "about"],
        properties: { id: { type: "string", description: "q1, q2, q3" }, text: { type: "string" }, about: { type: "array", items: { type: "string" } } },
      },
    },
  },
} as const;

export const REVISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["lines"],
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "text", "kind", "cites", "change", "because", "why"],
        properties: {
          ...lineSchema.properties,
          change: { type: "string", enum: [...CHANGES] },
          because: { type: "string", description: "The question id whose answer changed this line, or empty" },
          why: { type: "string", description: "One short clause, in the person's terms; empty for kept lines" },
        },
      },
    },
  },
} as const;

function lineOf(raw: unknown, historyIds: Set<string>, seen: Set<string>): NoteLine | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  const id = str(o.id, 24).toLowerCase();
  const text = str(o.text, MAX_LINE_CHARS);
  const kind = NOTE_KINDS.find((k) => k === o.kind);
  // Citations: real history ids only, each once; a line with none left rests on nothing and goes.
  const cites = [...new Set(Array.isArray(o.cites) ? o.cites.map((c) => str(c, 24)).filter((c) => historyIds.has(c)) : [])];
  if (!ID_RE.test(id) || seen.has(id) || !text || !kind || !cites.length) return null;
  seen.add(id);
  return { id, text, kind, cites };
}

/** The drafted note: at most MAX_NOTE_LINES lines, each citing decisions that exist. */
export function parseNote(raw: unknown, history: HistoryItem[]): NoteLine[] {
  const ids = new Set(history.map((h) => h.id));
  const seen = new Set<string>();
  const lines = (Array.isArray((raw as { lines?: unknown })?.lines) ? (raw as { lines: unknown[] }).lines : [])
    .map((l) => lineOf(l, ids, seen))
    .filter((l): l is NoteLine => l !== null)
    .slice(0, MAX_NOTE_LINES);
  if (!lines.length) throw new OnboardingError("the note has no line that cites a real decision");
  return lines;
}

export function parseInterview(raw: unknown, note: NoteLine[]): InterviewQuestion[] {
  const lineIds = new Set(note.map((l) => l.id));
  const seen = new Set<string>();
  const qs = (Array.isArray((raw as { questions?: unknown })?.questions) ? (raw as { questions: unknown[] }).questions : [])
    .map((q): InterviewQuestion | null => {
      const o = (q ?? {}) as Record<string, unknown>;
      const id = str(o.id, 24).toLowerCase();
      const text = str(o.text, MAX_QUESTION_CHARS);
      const about = [...new Set(Array.isArray(o.about) ? o.about.map((a) => str(a, 24).toLowerCase()).filter((a) => lineIds.has(a)) : [])];
      if (!ID_RE.test(id) || seen.has(id) || !text || !about.length) return null;
      seen.add(id);
      return { id, text, about };
    })
    .filter((q): q is InterviewQuestion => q !== null)
    .slice(0, MAX_QUESTIONS);
  if (!qs.length) throw new OnboardingError("no interview question about a line of the note");
  return qs;
}

/** The person's interview answers, by question id: only questions that were asked, each trimmed. */
export function parseAnswers(raw: unknown, questions: InterviewQuestion[]): Record<string, string> {
  const o = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const q of questions) {
    const a = str(o[q.id], MAX_ANSWER_CHARS);
    if (a) out[q.id] = a;
  }
  if (!Object.keys(out).length) throw new OnboardingError("no answers");
  return out;
}

/**
 * The revised note. Lines keep their citations to history; a change has to name the question whose answer
 * caused it, so what came from the history and what came from the person stay apart.
 */
export function parseRevision(raw: unknown, note: NoteLine[], history: HistoryItem[], answers: Record<string, string>): RevisedLine[] {
  const ids = new Set(history.map((h) => h.id));
  const before = new Map(note.map((l) => [l.id, l]));
  const seen = new Set<string>();
  const lines = (Array.isArray((raw as { lines?: unknown })?.lines) ? (raw as { lines: unknown[] }).lines : [])
    .map((r): RevisedLine | null => {
      const o = (r ?? {}) as Record<string, unknown>;
      const change = CHANGES.find((c) => c === o.change);
      const id = str(o.id, 24).toLowerCase();
      const text = str(o.text, MAX_LINE_CHARS);
      const kind = NOTE_KINDS.find((k) => k === o.kind);
      const because = str(o.because, 24).toLowerCase();
      const why = str(o.why, MAX_LINE_CHARS);
      const cites = [...new Set(Array.isArray(o.cites) ? o.cites.map((c) => str(c, 24)).filter((c) => ids.has(c)) : [])];
      if (!change || !ID_RE.test(id) || seen.has(id)) return null;
      const prev = before.get(id);
      if (change === "kept") {
        if (!prev) return null;
        seen.add(id);
        return { ...prev, change };
      }
      // Anything the interview changed names the answer that changed it.
      if (!answers[because]) return null;
      if (change === "added") {
        if (prev || !text || !kind) return null;
        seen.add(id);
        return { id, text, kind, cites, change, because, ...(why ? { why } : {}) }; // may rest on the interview alone
      }
      if (!prev) return null;
      seen.add(id);
      if (change === "removed") return { ...prev, change, because, ...(why ? { why } : {}) };
      return { id, text: text || prev.text, kind: kind ?? prev.kind, cites: cites.length ? cites : prev.cites, change, because, ...(why ? { why } : {}) };
    })
    .filter((l): l is RevisedLine => l !== null);
  // Every original line is accounted for: one the model left out is kept as it was.
  for (const l of note) if (!seen.has(l.id)) lines.push({ ...l, change: "kept" });
  if (lines.filter((l) => l.change !== "removed").length > MAX_NOTE_LINES) throw new OnboardingError(`the revised note has more than ${MAX_NOTE_LINES} lines`);
  return lines;
}

/** Stand-ins for tests and the fake model: deterministic, from the history alone. */
export function fakeNote(history: HistoryItem[]): { lines: NoteLine[] } {
  const quick = history.filter((h) => (h.seconds ?? 99) <= 5).map((h) => h.id).slice(0, 4);
  const worded = history.filter((h) => h.reason || h.typed).map((h) => h.id).slice(0, 4);
  return {
    lines: [
      ...(quick.length ? [{ id: "n1", text: "Approves small housekeeping in seconds; doesn't want to be asked.", kind: "preference" as const, cites: quick }] : []),
      ...(worded.length ? [{ id: "n2", text: "Gives reasons when the call matters; ask for them there.", kind: "preference" as const, cites: worded }] : []),
    ],
  };
}

export function fakeInterview(note: NoteLine[]): { questions: InterviewQuestion[] } {
  return { questions: note.slice(0, 2).map((l, i) => ({ id: `q${i + 1}`, text: `Is this right: "${l.text}"`, about: [l.id] })) };
}

export function fakeRevision(note: NoteLine[], answers: Record<string, string>): { lines: RevisedLine[] } {
  const q = Object.keys(answers)[0] ?? "";
  return { lines: note.map((l, i) => (i === 0 && q ? { ...l, change: "changed" as const, text: `${l.text} (confirmed)`, because: q, why: "confirmed in the interview" } : { ...l, change: "kept" as const })) };
}

/**
 * An onboarding run on the owner's queue (docs/STAGE-10.md, 10b): the trimmed history it read and every
 * step after, kept together so the interview can be done later, on another device.
 */
export interface OnboardingRun {
  id: string;
  created_at: string;
  history: HistoryItem[];
  note: NoteLine[];
  questions?: InterviewQuestion[];
  answers?: Record<string, string>;
  revised?: RevisedLine[];
  /** When the person kept the revised note as facts. */
  kept_at?: string;
}

/** The facts a kept note becomes: one per line still standing, ids tied to the run so keeping twice is a no-op. */
export function factsFromNote(run: Pick<OnboardingRun, "id" | "revised" | "note">, maxChars: number): { id: string; text: string; source: string; scope: string }[] {
  const lines = (run.revised ?? run.note.map((l) => ({ ...l, change: "kept" as const }))).filter((l) => l.change !== "removed");
  return lines.map((l) => ({
    // Fact ids are at most 12 characters (the context's check): "o" + 5 of the run's id + the line's id.
    id: `o${run.id.slice(0, 5)}-${l.id}`.slice(0, 12),
    text: l.text.slice(0, maxChars),
    scope: "all",
    source: l.change === "added" ? "onboarding interview" : `onboarding, from ${l.cites.length} decision${l.cites.length === 1 ? "" : "s"}${l.change === "changed" ? " and the interview" : ""}`,
  }));
}
