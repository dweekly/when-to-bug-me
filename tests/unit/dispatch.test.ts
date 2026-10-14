// Dispatch (docs/STAGE-8.md): the catalog comes in clean, the draft stays inside it, code decides where
// work runs and what must happen first, the command can't be turned into anything but one `claude`
// call, and the owner's drafts never reach the cache, the recorded run or the logs.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUGME_PREFIX,
  type Brief,
  type BriefDraft,
  type Catalog,
  DispatchError,
  briefText,
  buildCommand,
  commandArgs,
  dispatchSchema,
  finishBrief,
  parseBriefDraft,
  parseCatalog,
  parseEdits,
  parseReport,
  runWhere,
  toolPrefix,
} from "../../src/shared/dispatch";
import { fakeDispatch } from "../../src/shared/fakeDispatch";
import catalogJson from "../../fixtures/catalog.json";
import { parseMcpList } from "../../mcp/bugme.mjs";

const server = (name: string, status = "connected") => ({ name, prefix: toolPrefix(name), status });
const CAT: Catalog = parseCatalog({ servers: [server("bugme"), server("GitHub"), server("claude.ai Gmail"), server("PagerDuty", "needs authentication")], skills: ["frontend-design"] });
const RULES = [{ id: "R10", text: "If a task runs past twice its time budget, stop and check in with me." }];

const draft = (over: Record<string, unknown> = {}) => ({
  ...fakeDispatch("Spin up a quick demo of the usage dashboard for Thursday", "", CAT),
  ...over,
});

describe("the catalog comes in clean", () => {
  it("takes Claude Code's tool prefix for each name", () => {
    expect(toolPrefix("claude.ai Gmail")).toBe("mcp__claude_ai_Gmail");
    expect(toolPrefix("plugin:design:slack")).toBe("mcp__plugin_design_slack");
    expect(toolPrefix("plugin:marketing:amplitude-eu")).toBe("mcp__plugin_marketing_amplitude-eu");
  });

  it("rejects a prefix that isn't its name's, or a skill name with shell in it", () => {
    expect(() => parseCatalog({ servers: [{ name: "x", prefix: "mcp__x$(id)", status: "connected" }], skills: [] })).toThrow(DispatchError);
    expect(() => parseCatalog({ servers: [{ name: "x", prefix: "mcp__y", status: "connected" }], skills: [] })).toThrow(DispatchError);
    expect(() => parseCatalog({ servers: [], skills: ["a;rm -rf ~"] })).toThrow(DispatchError);
    expect(() => parseCatalog({ servers: [{ name: "x", prefix: "mcp__x", status: "maybe" }], skills: [] })).toThrow(DispatchError);
  });

  it("Jordan's catalog parses", () => {
    expect(parseCatalog(catalogJson).servers.some((s) => s.prefix === BUGME_PREFIX)).toBe(true);
  });

  it("reads names and statuses from `claude mcp list`, and drops the command or URL", () => {
    const out = [
      "Checking MCP server health…",
      "",
      "bugme: node /Users/someone/bugme.mjs - ✔ Connected",
      "claude.ai Gmail: https://gmail.example/mcp?key=SECRET - ✔ Connected",
      "plugin:design:slack: https://slack.example - with - dashes - ! Needs authentication",
      "plugin:design:gmail: npx thing - Not configured",
      "broken: cmd - ✗ Failed to connect",
    ].join("\n");
    const s = parseMcpList(out);
    expect(s.map((x) => x.name)).toEqual(["bugme", "claude.ai Gmail", "plugin:design:slack", "plugin:design:gmail", "broken"]);
    expect(s.map((x) => x.status)).toEqual(["connected", "connected", "needs authentication", "not configured", "failed"]);
    expect(JSON.stringify(s)).not.toMatch(/SECRET|Users|npx|https/);
    expect(() => parseCatalog({ servers: s, skills: [] })).not.toThrow();
  });
});

describe("the draft stays inside the catalog", () => {
  it("drops tools and skills that aren't in it, and caps the lists", () => {
    const d = parseBriefDraft(draft({ tools_off: ["mcp__GitHub", "mcp__Nope"], skills: ["frontend-design", "made-up"], done: ["a", "b", "c", "d", "e"] }), CAT, RULES, []);
    expect(d.tools_off).toEqual(["mcp__GitHub"]);
    expect(d.skills).toEqual(["frontend-design"]);
    expect(d.done).toHaveLength(3);
  });

  it("keeps guidance only where it quotes a current rule, as the whole rule", () => {
    const d = parseBriefDraft(draft({ guidance: ["runs past twice its time budget", "Always use Rust."] }), CAT, RULES, []);
    expect(d.guidance).toEqual([RULES[0].text]);
  });

  it("rejects a model, effort or mode outside the enums, including bypassPermissions", () => {
    expect(() => parseBriefDraft(draft({ model: "gpt-9" }), CAT, [], [])).toThrow(DispatchError);
    expect(() => parseBriefDraft(draft({ permission_mode: "bypassPermissions" }), CAT, [], [])).toThrow(DispatchError);
    expect(() => parseBriefDraft(draft({ effort: "turbo" }), CAT, [], [])).toThrow(DispatchError);
  });

  it("the schema's tool fields are enums of the catalog's prefixes", () => {
    const s = dispatchSchema(CAT);
    expect(s.properties.tools_off).toEqual({ type: "array", items: { type: "string", enum: CAT.servers.map((x) => x.prefix) } });
    expect(s.properties.permission_mode.enum).not.toContain("bypassPermissions");
  });
});

describe("code decides where it runs and what comes first", () => {
  it("sensitive and not urgent runs locally; sensitive and urgent adds a check-in; the rest is cloud", () => {
    expect(runWhere("high", "low").where).toBe("local");
    expect(runWhere("high", "high")).toMatchObject({ where: "cloud", checkIn: expect.stringMatching(/sensitive/) });
    expect(runWhere("medium", "low")).toEqual({ where: "cloud", reason: "" });
  });

  const finish = (d: BriefDraft, owner = true, c = CAT) => finishBrief(d, c, { id: "b-abcdefghij", task: "t", now: new Date("2026-10-13T12:00:00Z"), owner });

  it("never turns Bug Me's server off, nor a tool the task needs", () => {
    const b = finish(parseBriefDraft(draft({ tools_off: [BUGME_PREFIX, "mcp__GitHub"], tools_needed: ["mcp__GitHub"] }), CAT, [], []));
    expect(b.tools_off).toEqual([]);
  });

  it("a needed tool that isn't connected becomes the first prerequisite", () => {
    const b = finish(parseBriefDraft(draft({ tools_needed: ["mcp__PagerDuty"], prerequisites: [{ what: "Pick the on-call rotation", why: "x" }] }), CAT, [], []));
    expect(b.prerequisites.map((p) => p.what)).toEqual(["Connect PagerDuty", "Pick the on-call rotation"]);
  });

  it("an owner without Bug Me's server connected is told to connect it first; the public demo isn't", () => {
    const noBugme = parseCatalog({ servers: [server("GitHub")], skills: [] });
    const d = parseBriefDraft(draft(), noBugme, [], []);
    expect(finish(d, true, noBugme).prerequisites[0].what).toBe("Connect Bug Me's MCP server");
    expect(finish(d, false, noBugme).prerequisites.map((p) => p.what)).not.toContain("Connect Bug Me's MCP server");
  });

  it("edits stay inside the catalog and can't turn Bug Me off", () => {
    const ok = { model: "claude-sonnet-5-5", effort: "medium", permission_mode: "plan", estimate_minutes: 20, budget_usd: 1.5, tools_off: ["mcp__GitHub"] };
    expect(parseEdits(ok, CAT).tools_off).toEqual(["mcp__GitHub"]);
    expect(() => parseEdits({ ...ok, tools_off: [BUGME_PREFIX] }, CAT)).toThrow(DispatchError);
    expect(() => parseEdits({ ...ok, tools_off: ["mcp__x'; id"] }, CAT)).toThrow(DispatchError);
    expect(() => parseEdits({ ...ok, permission_mode: "dontAsk" }, CAT)).toThrow(DispatchError);
  });

  it("a report needs an outcome, a scope and a summary; cost is optional", () => {
    expect(parseReport({ outcome: "done", scope: "as briefed", summary: "Built it." })).not.toHaveProperty("cost_usd");
    expect(parseReport({ outcome: "stopped at tripwire", scope: "bigger", summary: "Half done.", cost_usd: 3 }).cost_usd).toBe(3);
    expect(() => parseReport({ outcome: "great", scope: "as briefed", summary: "x" })).toThrow(DispatchError);
    expect(() => parseReport({ outcome: "done", scope: "as briefed", summary: "" })).toThrow(DispatchError);
  });
});

describe("the command is one `claude` call, whatever the brief says", () => {
  // A stub `claude` that prints its arguments as JSON, first on PATH.
  const bin = mkdtempSync(join(tmpdir(), "bugme-argv-"));
  writeFileSync(join(bin, "claude"), `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)))\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const canary = join(bin, "pwned");

  const hostile = (): Brief => {
    const d = parseBriefDraft(
      draft({
        headline: "BRIEF $(touch PWN) `touch PWN`",
        goal: `It's "quoted" and 'single' $HOME \\ \`touch PWN\``,
        done: ["BRIEF", "line with BRIEF in it", "$(touch PWN)"],
        tools_off: ["mcp__GitHub", "mcp__claude_ai_Gmail"],
      }),
      CAT,
      [],
      [],
    );
    const b = finishBrief(d, CAT, { id: "b-abcdefghij", task: "t", now: new Date(), owner: true });
    // Point every injection attempt at the canary file.
    return JSON.parse(JSON.stringify(b).replaceAll("PWN", canary));
  };

  for (const shell of ["zsh", "bash"]) {
    it(`under ${shell}, every value arrives as a literal argument and nothing runs`, () => {
      const b = hostile();
      const out = execFileSync(shell, ["-c", buildCommand(b, CAT)], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" });
      expect(JSON.parse(out)).toEqual([
        "--model", b.model, "--effort", b.effort, "--permission-mode", b.permission_mode,
        "--disallowedTools", "mcp__GitHub", "--disallowedTools", "mcp__claude_ai_Gmail",
        "--", briefText(b, CAT),
      ]);
      // The runner's Launch passes commandArgs with no shell: the same list.
      expect(["claude", ...JSON.parse(out)]).toEqual(commandArgs(b, CAT));
      expect(() => execFileSync("test", ["-e", canary])).toThrow();
    });
  }

  it("keeps every tool turned off, up to the catalog's size", () => {
    const many = parseCatalog({ servers: [server("bugme"), ...Array.from({ length: 40 }, (_, i) => server(`tool${i}`))], skills: [] });
    const all = many.servers.filter((s) => s.prefix !== BUGME_PREFIX).map((s) => s.prefix);
    expect(parseBriefDraft(draft({ tools_off: all }), many, [], []).tools_off).toEqual(all);
    const ok = { model: "claude-haiku-5-5", effort: "low", permission_mode: "plan", estimate_minutes: 5, budget_usd: 1, tools_off: all };
    expect(parseEdits(ok, many).tools_off).toEqual(all);
  });

  it("refuses a tool prefix that slipped past the catalog", () => {
    const b = { ...hostile(), tools_off: ["mcp__x';id;'"] };
    expect(() => buildCommand(b, CAT)).toThrow(DispatchError);
  });

  it("the opening prompt carries the tripwire, the check-ins and the report", () => {
    const t = briefText(finishBrief(parseBriefDraft(draft(), CAT, [], []), CAT, { id: "b-abcdefghij", task: "t", now: new Date(), owner: true }), CAT);
    expect(t).toMatch(/At 60 minutes \(2× the estimate\), stop and use ask_bug_me/);
    expect(t).toMatch(/report_to_bug_me with brief "b-abcdefghij"/);
    expect(t).toMatch(/A guide only/);
  });

  it("the opening prompt carries the person's own words, exactly", () => {
    const d = parseBriefDraft(draft(), CAT, [], []);
    const task = 'Write banner.txt containing exactly "hello  world".\nThen stop.';
    const t = briefText(finishBrief(d, CAT, { id: "b-abcdefghij", task, answers: "For  me,\nby Friday.", now: new Date(), owner: true }), CAT);
    expect(t).toContain(task);
    expect(t).toContain("For  me,\nby Friday.");
  });
});

describe("the owner's drafts are never stored outside the owner's queue", () => {
  const SENTINEL = "SENTINEL-7f3a-private-task";
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("no recorded run, no cache read or write, and no sentinel in the logs, live or not", async () => {
    const cache = { match: vi.fn(), put: vi.fn(), delete: vi.fn() };
    vi.stubGlobal("caches", { default: cache });
    const create = vi.fn().mockResolvedValue({
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "text", text: JSON.stringify({ ...draft(), headline: "", goal: SENTINEL }) }],
    });
    vi.doMock("@anthropic-ai/sdk", () => {
      class Anthropic {
        messages = { create };
        static APIError = class extends Error {};
      }
      return { default: Anthropic };
    });
    const logged: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((...a) => void logged.push(...a));
    const { dispatchFor, ModelUnavailable } = await import("../../src/worker/model");
    const spend = { get: () => ({ reserve: async () => ({ ok: true, state: { day: "d", cap: 1 } }), reconcile: async () => {} }), idFromName: () => "x" };
    const env = { ...Object.fromEntries([["ANTHROPIC_API_KEY", "k"]]), SPEND: spend } as never;
    const ctx = { persona: { first_name: "David", name: "David", pronouns: "they/them", role: "Founder", company: "c", company_blurb: "b", fleet_size: 1, projects: [], how_to_work_with_me: [] } as never, store: false };

    // An answer that fails validation (no headline) is rejected without its text reaching the log.
    await expect(dispatchFor(env, true, SENTINEL, "", CAT, [], [], ctx)).rejects.toBeInstanceOf(ModelUnavailable);
    // A valid answer comes back live and is not cached.
    create.mockResolvedValueOnce({ stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: JSON.stringify(draft()) }] });
    expect((await dispatchFor(env, true, SENTINEL, "", CAT, [], [], ctx)).source).toBe("live");

    expect(create).toHaveBeenCalledTimes(2);
    expect(cache.match).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
    expect(JSON.stringify(logged)).not.toContain(SENTINEL);
  });
});
