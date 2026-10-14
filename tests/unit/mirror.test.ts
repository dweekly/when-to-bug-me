// Hooks into Bug Me (docs/STAGE-10.md, 10d): the hook's events become mirrored tickets that are shown,
// routed and closed, but never answered by Bug Me.
//
// The payloads in fixtures/hooks were captured from Claude Code 2.1.300 with a logging hook, in a
// scratch directory, on questions written for the capture: `claude -p --model claude-haiku-5-5
// --input-format stream-json --output-format stream-json --permission-prompt-tool stdio --settings <a
// settings file registering the hook>` (AskUserQuestion is only offered to a print-mode session whose
// host answers prompts), with the host answering "Red", a typed answer and "Lint, Types". Session ids,
// paths and the plan's text were replaced before they were saved; nothing comes from a real session.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { DEADLINE_MS, hookBody } from "../../mcp/bugme-hook.mjs";
import { MIRROR_HOOK_DEADLINE_MS, MIRROR_ORPHAN_MS } from "../../src/shared/constants";
import type { Card } from "../../src/shared/types";
import { LiveQueue, type MirrorItem, mapKV, reply } from "../../src/worker/live";
import { PLAN_QUESTION, type QuestionEvent, answerFromMirror, decisionFromMirror, mirrorId, mirrorView, newMirror, parseMirrorEvent } from "../../src/worker/mirror";

const fixture = (name: string) => JSON.parse(readFileSync(`fixtures/hooks/${name}.json`, "utf8")) as Record<string, unknown>;
const event = (name: string) => parseMirrorEvent(hookBody(fixture(name))) as QuestionEvent;

function card(id: string, route: Card["route"], settle = ""): Card {
  return {
    id,
    route,
    model_route: route,
    settle_option: settle,
    reversible: "yes",
    cost: "cheap",
    clearing_rule: route === "settle" ? "Small, clear changes: just do them." : "",
    rule_quoted: "",
    fact_quoted: "",
    why_here: "routed",
    headline: "routed",
    in_your_terms: "",
    problem: "fine",
    source: "code",
    sealed: "v1.x",
  };
}

async function items(ev: QuestionEvent): Promise<MirrorItem[]> {
  const n = ev.kind === "plan" ? 1 : ev.questions.length;
  return Promise.all(
    Array.from({ length: n }, async (_, i) => {
      const d = decisionFromMirror(ev, i, await mirrorId(ev.session, ev.toolUse, i));
      const answer = ev.event === "post" ? answerFromMirror(ev, i, d) : undefined;
      return { decision: d, card: card(d.id, "decide"), projectName: ev.project, mirror: newMirror(ev, i), ...(answer ? { answer } : {}) };
    }),
  );
}

describe("the hook's body", () => {
  it("carries the questions and options, never the transcript, the path, the plan or the last message", () => {
    for (const name of ["ask-pre", "ask-post", "plan-pre", "plan-post", "stop", "session-end"]) {
      const sent = JSON.stringify(hookBody(fixture(name)));
      expect(sent).not.toContain("transcript");
      expect(sent).not.toContain("/home/user");
      expect(sent).not.toContain("removed from this fixture");
      expect(sent).not.toContain("prompt_id");
    }
    expect(hookBody(fixture("ask-pre"))).toMatchObject({ event: "pre", tool: "AskUserQuestion", project: "demo-app" });
    expect(hookBody(fixture("plan-pre"))).toEqual({ event: "pre", session_id: fixture("plan-pre").session_id, tool_use_id: fixture("plan-pre").tool_use_id, tool: "ExitPlanMode", project: "demo-app", at: expect.any(Number) });
    expect(hookBody(fixture("stop"))).toEqual({ event: "stop", session_id: fixture("stop").session_id, at: expect.any(Number) });
    expect(hookBody({ ...fixture("ask-pre"), tool_name: "Bash" })).toBeNull();
    expect(DEADLINE_MS).toBe(MIRROR_HOOK_DEADLINE_MS);
  });
});

describe("adapters, on the captured payloads", () => {
  it("keeps every question and every option, with headers and multi-select", async () => {
    const ev = event("ask-pre");
    expect(ev.questions).toHaveLength(3);
    const ds = (await items(ev)).map((it) => it.decision);
    expect(ds.map((d) => d.options.length)).toEqual([4, 2, 3]);
    expect(ds[0].options.map((o) => `${o.key}:${o.label}`)).toEqual(["A:Red", "B:Green", "C:Blue", "D:Gray"]);
    expect(ds[0].options[3].description).toBe("Gray button");
    expect(ds[0].project).toBe("demo-app");
    expect(ds[0].no_recommendation).toBe(true);
    // Nothing mirrored can settle: every option is irreversible and of unknown cost.
    expect(Object.values(ds[0].bounds).every((b) => b.reversible === "no" && b.cost_usd >= 9999)).toBe(true);
    const ms = (await items(ev)).map((it) => it.mirror);
    expect(ms.map((m) => [m.header, m.multi, m.index, m.of])).toEqual([
      ["Color", false, 0, 3],
      ["Name", false, 1, 3],
      ["Checks", true, 2, 3],
    ]);
  });

  it("reads picked, typed and multi-select answers", async () => {
    const answers = (await items(event("ask-post"))).map((it) => it.answer);
    expect(answers[0]).toEqual({ text: "Red", keys: ["A"] });
    expect(answers[1]).toEqual({ text: "my own typed answer", keys: [], typed: "my own typed answer" });
    expect(answers[2]).toEqual({ text: "Lint, Types", keys: ["A", "B"] });
  });

  it("splits a multi-select answer even when a label holds a comma, and keeps typed words beside picks", () => {
    const ev = parseMirrorEvent({
      event: "post",
      session_id: "s1",
      tool_use_id: "u1",
      tool: "AskUserQuestion",
      questions: [{ question: "Which?", multiSelect: true, options: [{ label: "Red, bright" }, { label: "Blue" }, { label: "Green" }] }],
      answers: { "Which?": "Green, Red, bright, also teal" },
    }) as QuestionEvent;
    const d = decisionFromMirror(ev, 0, "t-x");
    expect(answerFromMirror(ev, 0, d)).toEqual({ text: "Green, Red, bright, also teal", keys: ["A", "C"], typed: "also teal" });
  });

  it("asks a plan approval with no plan text", async () => {
    const [pre] = await items(event("plan-pre"));
    expect(pre.decision.question).toBe(PLAN_QUESTION);
    expect(pre.decision.options.map((o) => o.label)).toEqual(["Approve", "Keep planning"]);
    expect(JSON.stringify(pre)).not.toContain("removed from this fixture");
    const [post] = await items(event("plan-post"));
    expect(post.answer).toEqual({ text: "Approve", keys: ["A"] });
    expect(post.decision.id).toBe(pre.decision.id);
  });

  it("matches an answer to a label exactly, inner spacing included", () => {
    const ev = parseMirrorEvent({
      event: "post",
      session_id: "s1",
      tool_use_id: "u1",
      tool: "AskUserQuestion",
      questions: [{ question: "How  to install?", options: [{ label: "Use npm  ci" }, { label: "Use npm install" }] }],
      answers: { "How  to install?": "Use npm  ci" },
    }) as QuestionEvent;
    expect(answerFromMirror(ev, 0, decisionFromMirror(ev, 0, "t-x"))).toEqual({ text: "Use npm  ci", keys: ["A"] });
  });

  it("refuses what AskUserQuestion can't carry, and malformed ids", () => {
    const base = { event: "pre", session_id: "s1", tool_use_id: "u1", tool: "AskUserQuestion" };
    const q = (n: number) => ({ question: "Q?", options: Array.from({ length: n }, (_, i) => ({ label: `o${i}` })) });
    expect(() => parseMirrorEvent({ ...base, questions: [q(5)] })).toThrow(/1 to 4/);
    expect(() => parseMirrorEvent({ ...base, questions: [q(2), q(2), q(2), q(2), q(2)] })).toThrow(/1 to 4/);
    expect(() => parseMirrorEvent({ ...base, session_id: "../x" })).toThrow(/session_id/);
    expect(() => parseMirrorEvent({ ...base, tool: "Bash", questions: [q(2)] })).toThrow(/tool/);
    // The test-only delay is ignored unless the caller allows it (the Worker does only on the fake model).
    expect(parseMirrorEvent({ ...base, questions: [q(2)], test_delay_ms: 500 })).not.toHaveProperty("testDelayMs");
    expect(parseMirrorEvent({ ...base, questions: [q(2)], test_delay_ms: 500 }, true)).toHaveProperty("testDelayMs", 500);
  });
});

describe("correlation", () => {
  it("one id per session, tool call and question", async () => {
    expect(await mirrorId("s", "u", 0)).toBe(await mirrorId("s", "u", 0));
    expect(new Set([await mirrorId("s", "u", 0), await mirrorId("s", "u", 1), await mirrorId("s", "v", 0), await mirrorId("t", "u", 0)]).size).toBe(4);
    expect(await mirrorId("s", "u", 0)).toMatch(/^t-[a-z0-9]{20}$/);
  });

  it("a repeated PreToolUse is one ticket per question", async () => {
    const q = new LiveQueue(mapKV());
    await q.mirrorOpen(await items(event("ask-pre")));
    await q.mirrorOpen(await items(event("ask-pre")));
    expect((await q.shown()).filter((t) => t.mirror)).toHaveLength(3);
  });

  it("PostToolUse closes the right questions, and a lost PreToolUse is no matter", async () => {
    const q = new LiveQueue(mapKV());
    const post = await items(event("ask-post"));
    await q.mirrorAnswer(post);
    const ids = post.map((it) => it.decision.id);
    const ts = await Promise.all(ids.map((id) => q.get(id)));
    expect(ts.map((t) => t?.status)).toEqual(["answered", "answered", "answered"]);
    expect(ts[0]?.answer).toMatchObject({ by: "session", outcome: "option", choice: "A", label: "Red" });
    expect(ts[1]?.answer).toMatchObject({ by: "session", outcome: "other", course: "my own typed answer" });
    expect(ts[2]?.answer).toMatchObject({ by: "session", choice: "A,B", label: "Lint, Types" });
    // The PreToolUse arriving late (or again) reopens nothing; nor does a repeated PostToolUse change it.
    await q.mirrorOpen(await items(event("ask-pre")));
    await q.mirrorAnswer(post);
    expect((await q.get(ids[0]))?.mirror?.state).toBe("answered");
    expect((await q.get(ids[0]))?.mirror?.answer).toEqual({ text: "Red", keys: ["A"] });
  });

  it("an answer that lands while routing is out is kept when routing finishes", async () => {
    const q = new LiveQueue(mapKV());
    const pre = await items(event("ask-pre"));
    await q.mirrorOpen(pre);
    expect((await q.unroutedMirrors()).length).toBe(3);
    await q.mirrorAnswer(await items(event("ask-post")));
    const id = pre[0].decision.id;
    const routed = await q.mirrorRouted(id, card(id, "check_in"));
    expect(routed?.status).toBe("answered");
    expect(routed?.mirror).toMatchObject({ state: "answered", routed: true, answer: { keys: ["A"] } });
    expect(routed?.card.route).toBe("check_in");
  });
});

describe("mirror only, enforced by the server", () => {
  it("a settle route is recorded as what Bug Me would have done, never acted on", async () => {
    const q = new LiveQueue(mapKV());
    const [it] = await items(event("plan-pre"));
    await q.mirrorOpen([it]);
    const id = it.decision.id;
    const t = await q.mirrorRouted(id, card(id, "settle", "A"));
    expect(t?.status).toBe("open");
    expect(t?.answer).toBeUndefined();
    expect(t?.card.route).toBe("check_in");
    expect(t?.mirror?.shadow).toEqual({ route: "settle", model_route: "settle", settle_option: "A", label: "Approve", rule: "Small, clear changes: just do them." });
  });

  it("a re-route after a rule change never settles a mirror, waiting or answered", async () => {
    const q = new LiveQueue(mapKV());
    const [a, b] = await items(event("ask-pre"));
    await q.mirrorOpen([a, b]);
    await q.setContext([{ id: "L1", text: "Colors: just do it." }], []);
    const rev = (await q.context()).rev;
    const t = await q.reroute(a.decision.id, card(a.decision.id, "settle", "A"), "Do A.", rev);
    expect(t?.status).toBe("open");
    expect(t?.answer).toBeUndefined();
    expect(t?.card.route).not.toBe("settle");
    expect(t?.mirror?.shadow?.route).toBe("settle");
    // Answered in the session, then re-routed: unchanged.
    await q.mirrorAnswer([{ ...b, answer: { text: "demo.sh", keys: ["A"] } }]);
    const before = await q.get(b.decision.id);
    expect(await q.reroute(b.decision.id, card(b.decision.id, "settle", "B"), "Do B.", rev)).toEqual(before);
  });

  it("the page can't resolve a mirror, and the session is told nothing to do", async () => {
    const q = new LiveQueue(mapKV());
    const [it] = await items(event("ask-pre"));
    await q.mirrorOpen([it]);
    await expect(q.resolve(it.decision.id, { outcome: "option", choice: "A" })).rejects.toThrow(/answered in its session/);
    const told = reply((await q.get(it.decision.id))!);
    expect(told).toEqual({ status: "pending", ticket: it.decision.id, mirror: true });
    await q.mirrorAnswer([{ ...it, answer: { text: "Red", keys: ["A"] } }]);
    const after = reply((await q.get(it.decision.id))!);
    expect(after).toEqual({ status: "answered", ticket: it.decision.id, mirror: true, answer: { text: "Red", keys: ["A"] } });
    expect(JSON.stringify(after)).not.toMatch(/instruction/);
  });

  it("mirrors are listed apart from answered asks, without their session ids", async () => {
    const q = new LiveQueue(mapKV());
    const its = await items(event("ask-post"));
    await q.mirrorAnswer(its);
    expect(await q.recentlyAnswered()).toHaveLength(0);
    expect(await q.recentMirrors()).toHaveLength(3);
    expect(mirrorView(its[0].mirror)).not.toHaveProperty("session");
    expect(mirrorView(its[0].mirror)).not.toHaveProperty("asked_at");
  });

  it("a routing failure is kept as the reason, never shown as a route", async () => {
    const q = new LiveQueue(mapKV());
    const [it] = await items(event("plan-pre"));
    await q.mirrorOpen([it]);
    const t = await q.mirrorRouted(it.decision.id, card(it.decision.id, "decide"), "today's budget is spent");
    expect(t?.mirror).toMatchObject({ routed: true, unrouted: "today's budget is spent" });
    expect(t?.mirror).not.toHaveProperty("shadow");
    // A later successful route replaces it.
    const ok = await q.mirrorRouted(it.decision.id, card(it.decision.id, "check_in"));
    expect(ok?.mirror).not.toHaveProperty("unrouted");
    expect(ok?.mirror?.shadow?.route).toBe("check_in");
  });
});

describe("orphans", () => {
  it("Stop or SessionEnd closes what the session asked and nobody answered; a later answer still wins", async () => {
    const q = new LiveQueue(mapKV());
    const pre = await items(event("ask-pre"));
    await q.mirrorOpen(pre);
    const later = pre[0].mirror.asked_at + 1000;
    expect(await q.mirrorEnd(pre[0].mirror.session, "the session moved on", later)).toBe(3);
    const t = await q.get(pre[0].decision.id);
    expect(t?.status).toBe("closed");
    expect(t?.mirror).toMatchObject({ state: "closed", closed_why: "the session moved on" });
    expect(await q.shown()).toHaveLength(0);
    expect(await q.mirrorEnd(pre[0].mirror.session, "the session ended", later + 1)).toBe(0);
    await q.mirrorAnswer(await items(event("ask-post")));
    expect((await q.get(pre[0].decision.id))?.mirror?.state).toBe("answered");
    // Another session's end touches nothing of this one.
    expect(await q.mirrorEnd("someone-else", "the session ended", later)).toBe(0);
  });

  it("puts out-of-order events back in order by when the hook saw them", async () => {
    const at = (name: string, t: number) => parseMirrorEvent({ ...hookBody(fixture(name)), at: t }) as QuestionEvent;
    const q = new LiveQueue(mapKV());
    // A dismissed question, then SessionEnd, delivered the other way round: the question arrives closed.
    const asked = await items(at("ask-pre", 1_000));
    const session = asked[0].mirror.session;
    await q.mirrorEnd(session, "the session ended", 2_000);
    await q.mirrorOpen(asked);
    expect((await q.get(asked[0].decision.id))?.mirror).toMatchObject({ state: "closed", closed_why: "the session ended" });
    // The session resumes and asks again, later: that question waits, and an older Stop arriving late doesn't close it.
    const again = parseMirrorEvent({ ...hookBody(fixture("plan-pre")), session_id: session, at: 3_000 }) as QuestionEvent;
    const [plan] = await items(again);
    await q.mirrorOpen([plan]);
    expect(await q.mirrorEnd(session, "the session moved on", 2_500)).toBe(0);
    expect((await q.get(plan.decision.id))?.mirror?.state).toBe("pending");
    expect(await q.mirrorEnd(session, "the session moved on", 3_500)).toBe(1);
  });

  it("a mirror with no answer and no end closes after the orphan time", async () => {
    const q = new LiveQueue(mapKV());
    const t0 = new Date("2026-10-14T09:00:00Z");
    const [it] = await items(event("plan-pre"));
    await q.mirrorOpen([it], t0);
    expect(await q.sweepMirrors(new Date(t0.getTime() + 60_000))).toBe(t0.getTime() + MIRROR_ORPHAN_MS);
    expect((await q.get(it.decision.id))?.status).toBe("open");
    expect(await q.sweepMirrors(new Date(t0.getTime() + MIRROR_ORPHAN_MS + 1))).toBeUndefined();
    expect((await q.get(it.decision.id))?.mirror).toMatchObject({ state: "closed", closed_why: expect.stringMatching(/no answer seen/) });
  });
});

describe("the hook script never holds a session up", () => {
  const run = (url: string, input: string, extra: Record<string, string> = {}) =>
    new Promise<{ code: number | null; out: string; ms: number }>((resolve) => {
      const start = Date.now();
      const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_") && !k.startsWith("BUGME_"))), BUGME_URL: url, ...Object.fromEntries([["BUGME_TOKEN", "test-key"]]), ...extra };
      const p = spawn("node", ["mcp/bugme-hook.mjs"], { env, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.on("close", (code) => resolve({ code, out, ms: Date.now() - start }));
      p.stdin.end(input);
    });
  const listen = (handler: Parameters<typeof createServer>[1]) =>
    new Promise<{ server: Server; url: string }>((resolve) => {
      const server = createServer(handler);
      server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }));
    });
  const pre = JSON.stringify(fixture("ask-pre"));

  it("exits 0, silently, when the server hangs", async () => {
    const { server, url } = await listen(() => {}); // never answers
    const r = await run(url, pre);
    server.closeAllConnections();
    server.close();
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    // It waited for the server until the deadline, and no longer.
    expect(r.ms).toBeGreaterThanOrEqual(DEADLINE_MS - 100);
    expect(r.ms).toBeLessThan(DEADLINE_MS + 1500);
  }, 10_000);

  it("exits 0, silently, when the request is refused, and posts only the trimmed body", async () => {
    let got: { path?: string; auth?: string; body?: string } = {};
    const { server, url } = await listen((req, res) => {
      let b = "";
      req.on("data", (d) => (b += d));
      req.on("end", () => {
        got = { path: req.url, auth: req.headers.authorization, body: b };
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"no"}');
      });
    });
    const r = await run(url, pre);
    server.close();
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(got.path).toBe("/api/me/mirror");
    expect(got.auth).toBe("Bearer test-key");
    expect(JSON.parse(got.body!)).toEqual({ ...hookBody(fixture("ask-pre")), at: expect.any(Number) });
  });

  it("exits 0 on garbage, on an event it ignores, and with no BUGME_URL", async () => {
    expect((await run("http://127.0.0.1:9", "not json")).code).toBe(0);
    expect((await run("http://127.0.0.1:9", JSON.stringify({ hook_event_name: "Notification" }))).code).toBe(0);
    expect((await run("", pre)).code).toBe(0);
  });
});
