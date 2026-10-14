// Stage 10b (docs/STAGE-10.md): the owner's history import, the runner-only routes' storage, and privacy.
import { describe, expect, it } from "vitest";
import { type ExtractRow, allowed, projectLabel, toHistory } from "../../scripts/onboard";
import { MAX_FACTS, MAX_RULE_CHARS } from "../../src/shared/constants";
import { type OnboardingRun, factsFromNote, parseHistory } from "../../src/shared/onboarding";
import { LiveQueue, mapKV } from "../../src/worker/live";

const row = (over: Partial<ExtractRow>): ExtractRow => ({
  machine: "m1",
  project: "-Users-someone-dev-app",
  session: "s1",
  call_id: "c1",
  q_index: 0,
  ts: "2026-10-01T10:00:00Z",
  call_status: "answered",
  question: "Which way?",
  options: [{ label: "Left" }, { label: "Right" }],
  rec_idx: 0,
  rec_source: "explicit",
  answer: "Right",
  answer_kind: "override_option",
  chosen_idx: 1,
  free_text: null,
  note: null,
  ...over,
});

describe("rows become onboarding history", () => {
  it("labels a project by its folder's last part", () => {
    expect(projectLabel("-Users-someone-dev-app")).toBe("app");
    expect(projectLabel("-Users-someone-dev-app-topic")).toBe("app-topic");
  });

  it("only allowed projects; deny markers and sessions win; sibling worktrees count as the project", () => {
    const allow = ["-Users-someone-dev-app"];
    expect(allowed(row({}), allow, [], new Set())).toBe(true);
    expect(allowed(row({ project: "-Users-someone-dev-app-topic" }), allow, [], new Set())).toBe(true);
    expect(allowed(row({ project: "-Users-someone-dev-other" }), allow, [], new Set())).toBe(false);
    expect(allowed(row({}), allow, ["app"], new Set())).toBe(false);
    expect(allowed(row({}), allow, [], new Set(["m1 s1"]))).toBe(false);
    expect(allowed(row({ project: "" }), allow, [], new Set())).toBe(false);
  });

  it("answered only, each call-and-question once, newest first, capped; typed and picked answers kept", () => {
    const rows = [
      row({ call_id: "old", ts: "2026-09-01T00:00:00Z" }),
      row({ call_id: "new", ts: "2026-10-10T00:00:00Z", chosen_idx: null, answer_kind: "free_text", answer: "Neither, do X", free_text: "Neither, do X", note: "because Y" }),
      row({ call_id: "new", ts: "2026-10-10T00:00:00Z" }),
      row({ call_id: "rej", call_status: "rejected_by_user" }),
      row({ call_id: "un", answer_kind: "unanswered", answer: null, chosen_idx: null }),
      row({ call_id: "multi", ts: "2026-10-05T00:00:00Z", multi_select: true, answer_kind: "multiselect", chosen_idx: null, answer: "Left, Right" }),
    ];
    const h = toHistory(rows, new Date("2026-10-14T00:00:00Z"));
    expect(h).toHaveLength(3);
    expect(h[0]).toMatchObject({ answer: null, typed: "Neither, do X", reason: "because Y", days_ago: 4 });
    expect(h[1]).toMatchObject({ answer: null, typed: "Left, Right" });
    expect(h[2]).toMatchObject({ answer: "B", recommended: "A" });
    expect(new Set(h.map((x) => x.id)).size).toBe(3);
    // The Worker accepts what the import sends.
    expect(parseHistory(h)).toHaveLength(3);
    expect(toHistory(Array.from({ length: 300 }, (_, i) => row({ call_id: `c${i}` })), new Date(), 200)).toHaveLength(200);
  });

  it("a fallback recommendation is not treated as the agent's", () => {
    expect(toHistory([row({ rec_source: "fallback_first" })], new Date())[0].recommended).toBeUndefined();
  });
});

describe("keeping the note", () => {
  const run: OnboardingRun = {
    id: "r1",
    created_at: "2026-10-14T00:00:00Z",
    history: parseHistory([{ id: "h1", question: "q", options: [{ key: "A", label: "a" }], answer: "A" }]),
    note: [{ id: "n1", text: "Line one", kind: "preference", cites: ["h1"] }, { id: "n2", text: "Line two", kind: "preference", cites: ["h1"] }],
    revised: [
      { id: "n1", text: "Line one", kind: "preference", cites: ["h1"], change: "kept" },
      { id: "n2", text: "Line two", kind: "preference", cites: ["h1"], change: "removed", because: "q1" },
      { id: "n3", text: "New line", kind: "rule-like", cites: [], change: "added", because: "q1" },
    ],
  };

  it("becomes facts (never rules) for the lines still standing, with their provenance", () => {
    const facts = factsFromNote(run, MAX_RULE_CHARS);
    expect(facts.map((f) => f.text)).toEqual(["Line one", "New line"]);
    expect(facts[1].source).toBe("onboarding interview");
    // The context refuses fact ids over 12 characters.
    for (const f of facts) expect(f.id.length).toBeLessThanOrEqual(12);
  });

  it("keeping twice adds nothing; the limit on facts holds", async () => {
    const q = new LiveQueue(mapKV());
    const facts = factsFromNote(run, MAX_RULE_CHARS);
    const note = { lines: facts.map((f) => f.text), source: "test" };
    expect(await q.keepNote(run, facts, note, MAX_FACTS)).toEqual({ ok: true, added: 2 });
    expect(await q.keepNote(run, facts, note, MAX_FACTS)).toEqual({ ok: true, added: 0 });
    expect((await q.context()).facts).toHaveLength(2);
    expect((await q.context()).rules.length).toBeGreaterThan(0);
    expect((await q.note())?.lines).toEqual(["Line one", "New line"]);
    expect((await q.keepNote({ ...run, id: "r2" }, factsFromNote({ ...run, id: "r2" }, MAX_RULE_CHARS), note, 3)).ok).toBe(false);
  });
});

describe("the owner's onboarding is never stored outside their queue", () => {
  it("note, interview and revision through the runner: no cache read or write, no sentinel in the logs", async () => {
    const { vi } = await import("vitest");
    const SENTINEL = "SENTINEL-onboard-private-decision";
    const cache = { match: vi.fn(), put: vi.fn(), delete: vi.fn() };
    vi.stubGlobal("caches", { default: cache });
    const history = parseHistory([{ id: "h1", question: `${SENTINEL} which way?`, options: [{ key: "A", label: "a" }, { key: "B", label: "b" }], answer: "B", reason: SENTINEL }]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ output: { lines: [{ id: "n1", text: SENTINEL, kind: "preference", cites: ["nope"] }] } }))) // fails validation
      .mockResolvedValueOnce(new Response(JSON.stringify({ output: { lines: [{ id: "n1", text: "Goes against the agent", kind: "preference", cites: ["h1"] }] } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ output: { questions: [{ id: "q1", text: "Always?", about: ["n1"] }] } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "the model call timed out" }), { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    const logged: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((...a) => void logged.push(...a));
    try {
      const { noteFor, interviewFor, reviseFor, ModelUnavailable } = await import("../../src/worker/model");
      const env = { ...Object.fromEntries([["LOCAL_MODEL_URL", "http://127.0.0.1:8790/runner/model"], ["LOCAL_MODEL_TOKEN", "tok"]]), SPEND: {} } as never;
      const ctx = { persona: { first_name: "David", name: "David", pronouns: "they/them", role: "Founder", company: "c", company_blurb: "b", fleet_size: 1, projects: [], how_to_work_with_me: [] } as never, store: false };
      await expect(noteFor(env, true, [], history, ctx)).rejects.toBeInstanceOf(ModelUnavailable);
      const note = (await noteFor(env, true, [], history, ctx)).out;
      const questions = (await interviewFor(env, true, history, note, ctx)).out;
      await expect(reviseFor(env, true, history, note, questions, { q1: SENTINEL }, ctx)).rejects.toBeInstanceOf(ModelUnavailable);
      expect(cache.match).not.toHaveBeenCalled();
      expect(cache.put).not.toHaveBeenCalled();
      expect(JSON.stringify(logged)).not.toContain(SENTINEL);
      for (const [, init] of fetchMock.mock.calls) expect(String((init as RequestInit).body)).toContain("prompt");
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});

describe("a kept note follows its facts", () => {
  it("editing a kept line's fact edits the note; deleting every one brings back the distilled note", async () => {
    const q = new LiveQueue(mapKV());
    const run: OnboardingRun = { id: "r1", created_at: "2026-10-14T00:00:00Z", history: parseHistory([{ id: "h1", question: "q", options: [{ key: "A", label: "a" }], answer: "A" }]), note: [{ id: "n1", text: "Previews, not diffs", kind: "preference", cites: ["h1"] }, { id: "n2", text: "Short summaries", kind: "preference", cites: ["h1"] }] };
    const facts = factsFromNote(run, MAX_RULE_CHARS);
    await q.keepNote(run, facts, { lines: facts.map((f) => f.text), fact_ids: facts.map((f) => f.id), source: "test" }, MAX_FACTS);
    const c = await q.context();
    await q.setContext(c.rules, c.facts.map((f) => (f.id === facts[0].id ? { ...f, text: "Diffs are fine" } : f)));
    expect((await q.note())?.lines).toEqual(["Diffs are fine", "Short summaries"]);
    await q.setContext(c.rules, []);
    expect(await q.note()).toBeUndefined();
  });
});
