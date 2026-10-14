// Stage 10 (docs/STAGE-10.md): onboarding's note, interview and revision, checked by code.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EFFORT, MAX_TOKENS, MODEL } from "../../src/shared/constants";
import { modelCacheKey } from "../../src/shared/hash";
import {
  INTERVIEW_SCHEMA,
  MAX_NOTE_LINES,
  NOTE_SCHEMA,
  OnboardingError,
  REVISION_SCHEMA,
  parseAnswers,
  parseHistory,
  parseInterview,
  parseNote,
  parseRevision,
} from "../../src/shared/onboarding";
import { ONBOARDING_ANSWERS } from "../../src/shared/onboardingScript";
import { ONBOARD_PROMPT_VERSION, interviewPrompt, notePrompt, revisePrompt } from "../../src/shared/prompts";
import type { Persona, Rule } from "../../src/shared/types";

const read = <T>(p: string) => JSON.parse(readFileSync(p, "utf8")) as T;
const history = parseHistory(read<{ decisions: unknown[] }>("fixtures/history.json").decisions);
const persona = read<Persona>("fixtures/persona.json");
const rules = read<Rule[]>("fixtures/rules.json");
const entries = read<{ entries: Record<string, { output: unknown }> }>("fixtures/captures/recorded.json").entries;
const recorded = async (prompt: string, schema: object) =>
  entries[await modelCacheKey({ model: MODEL, effort: EFFORT, maxTokens: MAX_TOKENS, promptVersion: ONBOARD_PROMPT_VERSION, schema, prompt })]?.output;

describe("Jordan's history", () => {
  it("is 30 decisions with unique ids, each answered with an option or typed words", () => {
    expect(history).toHaveLength(30);
    expect(new Set(history.map((h) => h.id)).size).toBe(30);
    for (const h of history) expect(Boolean(h.answer) || Boolean(h.typed)).toBe(true);
  });
  it("refuses an answer that isn't one of the options", () => {
    expect(() => parseHistory([{ id: "x1", question: "q", options: [{ key: "A", label: "a" }], answer: "Z" }])).toThrow(OnboardingError);
  });
});

describe("the note cites real decisions", () => {
  it("drops citations that don't exist, and lines left with none", () => {
    const note = parseNote({ lines: [
      { id: "n1", text: "Real", kind: "preference", cites: ["h01", "h01", "h99"] },
      { id: "n2", text: "Invented", kind: "preference", cites: ["h99"] },
      { id: "n3", text: "Bad kind", kind: "vibe", cites: ["h02"] },
    ] }, history);
    expect(note).toEqual([{ id: "n1", text: "Real", kind: "preference", cites: ["h01"] }]);
  });
  it("keeps at most eight lines, and refuses a note with none", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `n${i + 1}`, text: `Line ${i}`, kind: "preference", cites: ["h01"] }));
    expect(parseNote({ lines: many }, history)).toHaveLength(MAX_NOTE_LINES);
    expect(() => parseNote({ lines: [] }, history)).toThrow(OnboardingError);
  });
});

describe("the interview and the revision", () => {
  const note = parseNote({ lines: [
    { id: "n1", text: "Previews, not diffs", kind: "preference", cites: ["h08", "h21"] },
    { id: "n2", text: "No SDK dependencies", kind: "rule-like", cites: ["h16"] },
  ] }, history);
  const questions = parseInterview({ questions: [{ id: "q1", text: "Is that a hard rule?", about: ["n2", "n9"] }, { id: "q2", text: "Orphan?", about: ["n9"] }] }, note);

  it("questions are about lines of the note", () => {
    expect(questions).toEqual([{ id: "q1", text: "Is that a hard rule?", about: ["n2"] }]);
  });
  it("answers only for questions that were asked", () => {
    expect(parseAnswers({ q1: " Yes, hard. ", q7: "stray" }, questions)).toEqual({ q1: "Yes, hard." });
    expect(() => parseAnswers({}, questions)).toThrow(OnboardingError);
  });
  it("a change names the answer behind it; an untouched line is kept as it was", () => {
    const answers = { q1: "Yes, hard." };
    const lines = parseRevision({ lines: [
      { id: "n2", text: "Hard rule: no SDK dependencies", kind: "rule-like", cites: ["h16", "h04"], change: "changed", because: "q1", why: "a hard rule now" },
      { id: "n3", text: "Unanchored change", kind: "preference", cites: [], change: "changed", because: "q9", why: "" },
      { id: "n4", text: "From the interview", kind: "rule-like", cites: [], change: "added", because: "q1", why: "said so" },
    ] }, note, history, answers);
    expect(lines.find((l) => l.id === "n2")).toMatchObject({ change: "changed", because: "q1", cites: ["h16", "h04"] });
    expect(lines.find((l) => l.id === "n4")).toMatchObject({ change: "added", cites: [] });
    expect(lines.find((l) => l.id === "n3")).toBeUndefined();
    expect(lines.find((l) => l.id === "n1")).toMatchObject({ change: "kept", text: "Previews, not diffs" });
  });
});

describe("the recorded onboarding (docs/STAGE-10.md)", () => {
  it("note, interview and revision are recorded, and every scripted answer is bound to a recorded question", async () => {
    const noteRaw = await recorded(notePrompt(persona, rules, history), NOTE_SCHEMA);
    expect(noteRaw, "re-record with `npm run record`").toBeDefined();
    const note = parseNote(noteRaw, history);
    const qRaw = await recorded(interviewPrompt(persona, history, note), INTERVIEW_SCHEMA);
    expect(qRaw).toBeDefined();
    const questions = parseInterview(qRaw, note);
    expect(Object.keys(ONBOARDING_ANSWERS).sort()).toEqual(questions.map((q) => q.id).sort());
    const answers = parseAnswers(ONBOARDING_ANSWERS, questions);
    const rRaw = await recorded(revisePrompt(persona, history, note, questions, answers), REVISION_SCHEMA);
    expect(rRaw).toBeDefined();
    expect(parseRevision(rRaw, note, history, answers).some((l) => l.change !== "kept")).toBe(true);
  });
  it("the drafting prompt never sees the hand-written note", () => {
    const prompt = notePrompt(persona, rules, history);
    for (const line of persona.how_to_work_with_me) expect(prompt).not.toContain(line);
  });
  it("the persona no longer claims its note was drafted by onboarding", () => {
    expect(persona.how_to_work_with_me_source).toMatch(/hand/i);
  });
});
