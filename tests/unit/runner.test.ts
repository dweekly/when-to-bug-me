// Stage 9 (docs/STAGE-9.md): the runner's front door, its model adapter and its launch helpers.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type GuardConfig, type Incoming, classify, decide } from "../../runner/guard";
import { backgroundId, launchArgs, listRepos, parseAgents, resolveRepo, LaunchError } from "../../runner/launch";
import { ModelCallError, ModelRunner, modelArgs, parseModelRequest } from "../../runner/model";
import { ensureEnvFile, parseEnvFile } from "../../runner/config";
import { type Catalog, commandArgs, finishBrief, parseBriefDraft, parseCatalog, toolPrefix } from "../../src/shared/dispatch";
import { fakeDispatch } from "../../src/shared/fakeDispatch";
import { cookieValue } from "../../src/worker/liveAuth";

const LIVE = "l".repeat(40);
const MODEL = "m".repeat(40);
const CFG: GuardConfig = { port: 8790, tailnetHost: "mac.tail1234.ts.net", ownerKey: LIVE, modelKey: MODEL };
const req = (over: Partial<Incoming>): Incoming => ({ method: "GET", path: "/me", host: "localhost:8790", origin: undefined, cookie: undefined, authorization: undefined, ...over });
const status = async (over: Partial<Incoming>) => {
  const v = await decide(req(over), CFG);
  return v.ok ? v.route : v.status;
};

describe("the runner's front door", () => {
  it("answers only to its own host names, exactly", async () => {
    expect(await status({})).toBe("static");
    expect(await status({ host: "127.0.0.1:8790" })).toBe("static");
    expect(await status({ host: "MAC.tail1234.ts.net" })).toBe("static");
    for (const host of [undefined, "localhost", "localhost:8791", "evil.localhost:8790", "localhost:8790.evil.com", "mac.tail1234.ts.net.evil.com", "attacker.example"]) {
      expect(await status({ host })).toBe(421);
    }
  });

  it("has no public world: the demo's routes and every route that can spend are gone", async () => {
    for (const path of ["/api/queue", "/api/dispatch", "/api/session", "/route", "/fact", "/converse", "/api/anything"]) expect(classify(path)).toBe("blocked");
    expect(await status({ path: "/api/dispatch", method: "POST", origin: "http://localhost:8790" })).toBe(404);
    expect(classify("/")).toBe("home");
    expect(classify("/app")).toBe("home");
  });

  it("owner routes need the owner, by cookie or bearer", async () => {
    const cookie = `bugme_owner=${await cookieValue(LIVE)}`;
    for (const path of ["/api/me/queue", "/api/me/briefs", "/runner/status"]) {
      expect(await status({ path })).toBe(401);
      expect(await status({ path, cookie: "bugme_owner=nope" })).toBe(401);
      expect(await status({ path, authorization: `Bearer ${MODEL}` })).toBe(401);
      expect(await status({ path, cookie })).not.toBe(401);
      expect(await status({ path, authorization: `Bearer ${LIVE}` })).not.toBe(401);
    }
  });

  it("a browser POST needs the exact origin; the MCP server's bearer needs none", async () => {
    const cookie = `bugme_owner=${await cookieValue(LIVE)}`;
    const post = (origin: string | undefined, host = "localhost:8790") => status({ method: "POST", path: "/runner/launch", cookie, origin, host });
    expect(await post("http://localhost:8790")).toBe("runner");
    expect(await post("https://mac.tail1234.ts.net", "mac.tail1234.ts.net")).toBe("runner");
    for (const origin of [undefined, "null", "http://localhost:8791", "https://localhost:8790", "http://127.0.0.1:8790", "http://mac.tail1234.ts.net", "https://evil.example"]) {
      expect(await post(origin)).toBe(403);
    }
    expect(await status({ method: "POST", path: "/api/me/tickets", authorization: `Bearer ${LIVE}` })).toBe("owner-api");
    expect(await status({ method: "POST", path: "/api/me/login", origin: "https://evil.example" })).toBe(403);
    expect(await status({ method: "POST", path: "/api/me/login", origin: "http://localhost:8790" })).toBe("signin");
  });

  it("the model callback takes its own token and nothing else", async () => {
    const cookie = `bugme_owner=${await cookieValue(LIVE)}`;
    expect(await status({ method: "POST", path: "/runner/model", authorization: `Bearer ${MODEL}` })).toBe("model");
    expect(await status({ method: "POST", path: "/runner/model" })).toBe(403);
    expect(await status({ method: "POST", path: "/runner/model", authorization: `Bearer ${LIVE}` })).toBe(403);
    expect(await status({ method: "POST", path: "/runner/model", cookie, origin: "http://localhost:8790" })).toBe(403);
  });

  it("static files are read-only", async () => {
    expect(await status({ method: "POST", path: "/style.css", origin: "http://localhost:8790" })).toBe(405);
  });
});

const FAKE = resolve("tests/fixtures/fake-claude.mjs");
function fakeState(extra: object = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bugme-runner-"));
  const file = join(dir, "fake.json");
  writeFileSync(file, JSON.stringify(extra));
  process.env.FAKE_CLAUDE_STATE = file;
  return { dir, read: () => JSON.parse(readFileSync(file, "utf8")) as { calls: { args: string[]; stdin?: string }[] } };
}

describe("model calls on the person's login", () => {
  it("customizations off, no transcript, and the prompt only on stdin", async () => {
    const s = fakeState();
    const prompt = "SENTINEL-owner-task: rename the billing table";
    const out = await new ModelRunner(FAKE, s.dir).run({ model: "claude-opus-5-5", effort: "low", schema: { type: "object" }, prompt });
    expect(out).toEqual({ prompt_chars: prompt.length });
    const call = s.read().calls[0];
    expect(call.args).toEqual(modelArgs({ model: "claude-opus-5-5", effort: "low", schema: { type: "object" } }));
    expect(call.args).toEqual(expect.arrayContaining(["--safe-mode", "--no-session-persistence", "--strict-mcp-config"]));
    expect(call.args.join(" ")).not.toContain("SENTINEL");
    expect(call.stdin).toBe(prompt);
  });

  it("kills a call at its deadline", async () => {
    const s = fakeState();
    process.env.FAKE_CLAUDE_SLEEP_MS = "5000";
    try {
      await expect(new ModelRunner(FAKE, s.dir, 2, 300).run({ model: "claude-haiku-5-5", effort: "low", schema: {}, prompt: "x" })).rejects.toThrow(ModelCallError);
    } finally {
      delete process.env.FAKE_CLAUDE_SLEEP_MS;
    }
  });

  it("runs at most two at once", async () => {
    const s = fakeState();
    process.env.FAKE_CLAUDE_SLEEP_MS = "300";
    try {
      const m = new ModelRunner(FAKE, s.dir, 2);
      const t0 = Date.now();
      await Promise.all([1, 2, 3, 4].map(() => m.run({ model: "claude-haiku-5-5", effort: "low", schema: {}, prompt: "x" })));
      // Four calls of ≥300 ms, two at a time: at least two rounds.
      expect(Date.now() - t0).toBeGreaterThanOrEqual(600);
    } finally {
      delete process.env.FAKE_CLAUDE_SLEEP_MS;
    }
  });

  it("the Worker's request comes in clean", () => {
    expect(() => parseModelRequest({ model: "gpt-6", effort: "low", schema: {}, prompt: "x" })).toThrow(ModelCallError);
    expect(() => parseModelRequest({ model: "claude-opus-5-5", effort: "ultra", schema: {}, prompt: "x" })).toThrow(ModelCallError);
    expect(() => parseModelRequest({ model: "claude-opus-5-5", effort: "low", schema: [], prompt: "x" })).toThrow(ModelCallError);
    expect(() => parseModelRequest({ model: "claude-opus-5-5", effort: "low", schema: {}, prompt: "" })).toThrow(ModelCallError);
  });
});

describe("launch", () => {
  // Inside a git hook, GIT_DIR and friends point at this repo; a test's `git init` must not inherit them.
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  function devRoot() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "bugme-dev-")));
    for (const n of ["app", "untrusted"]) {
      mkdirSync(join(root, n));
      execFileSync("git", ["init", "-q"], { cwd: join(root, n), env: gitEnv });
    }
    mkdirSync(join(root, "not-a-repo"));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "bugme-outside-")));
    execFileSync("git", ["init", "-q"], { cwd: outside, env: gitEnv });
    symlinkSync(outside, join(root, "linked"));
    return { root, trusted: new Set([join(root, "app"), outside]) };
  }

  it("lists git checkouts under the dev root, with trust; never a symlink", () => {
    const { root, trusted } = devRoot();
    expect(listRepos(root, trusted)).toEqual([{ name: "app", trusted: true }, { name: "untrusted", trusted: false }]);
  });

  it("resolves only a listed, trusted repo", () => {
    const { root, trusted } = devRoot();
    expect(resolveRepo(root, "app", trusted)).toBe(join(root, "app"));
    for (const name of ["untrusted", "not-a-repo", "linked", "..", "app/../untrusted", "missing"]) expect(() => resolveRepo(root, name, trusted)).toThrow(LaunchError);
  });

  it("the launch argv is Copy command's, named for the brief, with Bug Me's server pointed at the runner", () => {
    const server = (name: string) => ({ name, prefix: toolPrefix(name), status: "connected" });
    const cat: Catalog = parseCatalog({ servers: [server("bugme"), server("GitHub")], skills: [] });
    const b = finishBrief(parseBriefDraft(fakeDispatch("Tidy the README", "", cat), cat, [], []), cat, { id: "b-abcdefghij", task: "t", now: new Date(), owner: true });
    const args = launchArgs({ ...b, tools_off: ["mcp__GitHub"] }, cat, "/h/mcp.json");
    expect(args.slice(0, 7)).toEqual(["--bg", "--worktree", "bugme-b-abcdefghij", "-n", "bugme-b-abcdefghij", "--mcp-config", "/h/mcp.json"]);
    expect(args.slice(7)).toEqual(commandArgs({ ...b, tools_off: ["mcp__GitHub"] }, cat).slice(1));
    expect(args).toContain("--disallowedTools");
    expect(args.at(-2)).toBe("--");
  });

  it("reads the session id and Bug Me's sessions from the CLI", () => {
    expect(backgroundId("Starting background service…\nbackgrounded · 4e653586 · bugme-b-abcdefghij\n")).toBe("4e653586");
    expect(backgroundId("Workspace not trusted.")).toBeUndefined();
    const rows = [
      { id: "4e653586", name: "bugme-b-abcdefghij", status: "idle", state: "done", cwd: "/x" },
      { id: "11111111", name: "someone else's", status: "busy" },
      { id: "22222222", name: "bugme-b-../../x" },
    ];
    expect(parseAgents(JSON.stringify(rows))).toEqual([{ id: "4e653586", name: "bugme-b-abcdefghij", status: "idle", state: "done", cwd: "/x" }]);
    expect(parseAgents("not json")).toEqual([]);
  });
});

describe("the runner's secrets", () => {
  it("are made once, kept, and readable only by the person", () => {
    const home = mkdtempSync(join(tmpdir(), "bugme-home-"));
    const first = parseEnvFile(readFileSync(ensureEnvFile(home), "utf8"));
    expect(first.LIVE_TOKEN.length).toBeGreaterThanOrEqual(32);
    expect(first.SEAL_KEY && first.LOCAL_MODEL_TOKEN).toBeTruthy();
    expect(parseEnvFile(readFileSync(ensureEnvFile(home), "utf8"))).toEqual(first);
    expect(statSync(join(home, "runner.env")).mode & 0o777).toBe(0o600);
  });
});

describe("model calls: deadlines and shutdown", () => {
  it("time spent queued counts toward the deadline", async () => {
    const s = fakeState();
    process.env.FAKE_CLAUDE_SLEEP_MS = "400";
    try {
      const m = new ModelRunner(FAKE, s.dir, 1, 600);
      const req = { model: "claude-haiku-5-5", effort: "low", schema: {}, prompt: "x" };
      const [first, second] = await Promise.allSettled([m.run(req), m.run(req)]);
      // The first finishes at ~400 ms; the second would need until ~800 ms, past its 600 ms deadline.
      expect(first.status).toBe("fulfilled");
      expect(second.status).toBe("rejected");
    } finally {
      delete process.env.FAKE_CLAUDE_SLEEP_MS;
    }
  });

  it("stopping the runner stops calls in flight and refuses the queued ones", async () => {
    const s = fakeState();
    process.env.FAKE_CLAUDE_SLEEP_MS = "5000";
    try {
      const m = new ModelRunner(FAKE, s.dir, 1, 10_000);
      const req = { model: "claude-haiku-5-5", effort: "low", schema: {}, prompt: "x" };
      const calls = [m.run(req), m.run(req)];
      await new Promise((r) => setTimeout(r, 200));
      const t0 = Date.now();
      m.stopAll();
      const settled = await Promise.allSettled(calls);
      expect(settled.map((x) => x.status)).toEqual(["rejected", "rejected"]);
      expect(Date.now() - t0).toBeLessThan(2000);
      await expect(m.run(req)).rejects.toThrow(ModelCallError);
    } finally {
      delete process.env.FAKE_CLAUDE_SLEEP_MS;
    }
  });
});
