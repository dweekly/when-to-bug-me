#!/usr/bin/env node
// Bug Me's MCP server (docs/STAGE-7.md): lets a Claude Code session ask Bug Me instead of stopping to
// ask its person. Dependency-free stdio JSON-RPC (newline-delimited, as MCP's stdio transport is), so
// it runs with plain `node` and no build.
//
// Configuration:
//   BUGME_URL    where Bug Me runs, such as https://bugme.weekly.org
//   the token    from the macOS keychain (service "bugme-live"), or BUGME_TOKEN when set (tests)
//
// Dispatch (docs/STAGE-8.md): `node mcp/bugme.mjs sync-catalog` sends the names and statuses of this
// machine's MCP servers and skills (never commands, env or URLs), so briefs can turn tools on and off.
//
// Register it once (the keychain step prompts for the token):
//   security add-generic-password -s bugme-live -a "$USER" -w
//   claude mcp add bugme --scope user -e BUGME_URL=https://bugme.weekly.org -- node ~/dev/when-to-bug-me/mcp/bugme.mjs

import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

const POLL_MS = 3000;
/** One poll of a ticket, separately from the overall wait. */
const REQUEST_TIMEOUT_MS = 20_000;
/**
 * Asking routes the question (and titles it) before answering: two model calls, each up to 45 s on the
 * hosted Worker, or up to 180 s through the runner's Claude login (docs/STAGE-9.md). Past this, the
 * session gets its ticket to check later.
 */
const ASK_TIMEOUT_MS = 400_000;
const DEFAULT_WAIT_MIN = 5;
const MAX_WAIT_MIN = 10;

let ownerKey = null;
function ownerToken() {
  if (ownerKey) return ownerKey;
  if (process.env.BUGME_TOKEN) return (ownerKey = process.env.BUGME_TOKEN);
  try {
    ownerKey = execFileSync("security", ["find-generic-password", "-s", "bugme-live", "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    throw new Error('Bug Me has no owner key yet. Store it with `security add-generic-password -s bugme-live -a "$USER" -w`, or set BUGME_TOKEN.');
  }
  return ownerKey;
}

function baseUrl() {
  const u = process.env.BUGME_URL;
  if (!u) throw new Error("BUGME_URL is not set (for example https://bugme.weekly.org).");
  return u.replace(/\/+$/, "");
}

async function call(method, path, body, timeoutMs = REQUEST_TIMEOUT_MS) {
  const res = await fetch(`${baseUrl()}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
    method,
    headers: { authorization: `Bearer ${ownerToken()}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try {
    data = await res.json();
  } catch {
    data = { error: `HTTP ${res.status}` };
  }
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Requests the client cancelled (notifications/cancelled): their waits stop at the next poll. */
const cancelled = new Set();

/** Poll a ticket until it is no longer pending, the wait runs out, or the client cancels the call. */
async function waitFor(first, minutes, requestId) {
  let r = first;
  const until = Date.now() + Math.min(Math.max(0, Number(minutes) || 0), MAX_WAIT_MIN) * 60_000;
  while (r.status === "pending" && Date.now() < until && !cancelled.has(requestId)) {
    await sleep(POLL_MS);
    try {
      r = await call("GET", `/api/me/tickets/${r.ticket}`);
    } catch {
      // The ask exists; losing a poll mustn't lose its handle.
      return { ...r, note: `Couldn't reach Bug Me just now. The question is asked (ticket ${r.ticket}); call check_bug_me with it later. Don't guess the answer.` };
    }
  }
  if (r.status === "pending") {
    r.note = "David hasn't answered yet. Carry on with work that doesn't depend on this, and call check_bug_me with this ticket later. Don't guess the answer.";
  }
  return r;
}

const TOOLS = [
  {
    name: "ask_bug_me",
    description: [
      "Ask Bug Me, David's chief of staff, instead of stopping to ask David directly.",
      "Use it for anything that is David's to decide: business intent or product direction, production deploys, spending real money, deleting or overwriting data, anything going out under his name, and anything one of his rules says comes to him.",
      "Don't use it for routine technical calls; make those yourself.",
      "Bug Me settles what one of David's written rules clearly covers and answers at once, quoting the rule; otherwise it asks David and waits up to wait_minutes for his answer.",
      "Give honest, conservative reversibility and cost for each option: they decide whether Bug Me may settle it without him.",
      'Every result names its ticket. Statuses: "settled" (a rule covered it; follow the instruction), "answered" (follow the choice or course, the reason, the conditions and any guidance, not just the choice), "pending" (carry on with independent work and call check_bug_me later; never act as if it were answered), "set-aside" (don\'t proceed; the instruction says what David needs), "reopened" (David undid an automatic answer: reverse it if cheap, then wait).',
    ].join(" "),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["question", "options", "context"],
      properties: {
        question: { type: "string", description: "The decision, in plain words David would use." },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label", "reversible", "cost_usd"],
            properties: {
              label: { type: "string", description: "What this option does, as a short imperative." },
              pros: { type: "string" },
              cons: { type: "string" },
              reversible: { type: "string", enum: ["yes", "partly", "no"], description: "Can this be fully undone at little cost?" },
              cost_usd: { type: "number", description: "Money this option spends, in US dollars (0 if none)." },
            },
          },
        },
        recommended: { type: "string", description: "The label of the option you recommend, if any." },
        context: { type: "string", description: "What David needs to know to decide: what the work is, why this came up, what changes for users under each option." },
        project: { type: "string", description: "The project this is for. Defaults to the name of the working directory." },
        brief: { type: "string", description: 'The Bug Me brief this session was started from ("b-…"), if its opening prompt named one.' },
        session: { type: "string", description: "A short label for this session, such as what it is working on." },
        wait_minutes: { type: "number", description: `How long to wait for David before returning "pending" (default ${DEFAULT_WAIT_MIN}, at most ${MAX_WAIT_MIN}).` },
      },
    },
  },
  {
    name: "report_to_bug_me",
    description:
      'If this session was started from a Bug Me brief (its opening prompt names one, "b-…"), call this when you finish or stop: the outcome, whether the scope stayed as briefed, and a two-sentence summary. Call it again if you resume and finish later.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["brief", "outcome", "scope", "summary"],
      properties: {
        brief: { type: "string", description: 'The brief id from your opening prompt ("b-…").' },
        outcome: { type: "string", enum: ["done", "stopped at tripwire", "partial", "abandoned"] },
        scope: { type: "string", enum: ["as briefed", "smaller", "bigger"], description: "Compared with the brief's done-when and out-of-scope lists." },
        summary: { type: "string", description: "Two sentences: what you built or found, and anything left." },
        cost_usd: { type: "number", description: "Only if you actually know it; leave it out otherwise." },
      },
    },
  },
  {
    name: "check_bug_me",
    description:
      'Check on a question asked with ask_bug_me, by its ticket. Waits up to wait_minutes (default 0) for an answer. Statuses: "answered" (follow the choice, reason, conditions and guidance), "settled" (a rule covered it), "pending", "set-aside" (don\'t proceed), "reopened" (David undid an automatic answer: reverse what you did if it is cheap, then wait).',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ticket"],
      properties: {
        ticket: { type: "string" },
        wait_minutes: { type: "number" },
      },
    },
  },
];

async function runTool(name, args, requestId) {
  // Claude Code sets CLAUDE_PROJECT_DIR to the session's project root; the working directory is the fallback.
  const project = basename(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (name === "ask_bug_me") {
    const first = await call("POST", "/api/me/tickets", {
      question: args.question,
      options: args.options,
      recommended: args.recommended,
      context: args.context,
      project: args.project || project,
      session: args.session || `Claude Code in ${project}`,
      ...(args.brief ? { brief: args.brief } : {}),
    }, ASK_TIMEOUT_MS);
    return waitFor(first, args.wait_minutes ?? DEFAULT_WAIT_MIN, requestId);
  }
  if (name === "report_to_bug_me") {
    if (!/^b-[a-z0-9]{10}$/.test(String(args.brief ?? ""))) throw new Error("brief must look like b-xxxxxxxxxx");
    const { outcome, scope, summary, cost_usd } = args;
    return call("POST", `/api/me/briefs/${args.brief}/report`, { outcome, scope, summary, ...(typeof cost_usd === "number" ? { cost_usd } : {}) });
  }
  if (name === "check_bug_me") {
    if (!/^t-[a-z0-9]{1,32}$/.test(String(args.ticket ?? ""))) throw new Error("ticket must look like t-xxxxxxxx");
    return waitFor(await call("GET", `/api/me/tickets/${args.ticket}`), args.wait_minutes ?? 0, requestId);
  }
  throw new Error(`unknown tool ${name}`);
}

function send(msg) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "notifications/cancelled" && params?.requestId !== undefined) cancelled.add(params.requestId);
  if (id === undefined) return; // a notification, such as notifications/initialized
  try {
    if (method === "initialize") {
      return send({
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "bugme", version: "0.1.0" },
          instructions: "Ask Bug Me (ask_bug_me) instead of stopping to ask David, for anything that is his to decide. A pending answer means keep working on something else and check back.",
        },
      });
    }
    if (method === "ping") return send({ id, result: {} });
    if (method === "tools/list") return send({ id, result: { tools: TOOLS } });
    if (method === "tools/call") {
      try {
        const out = await runTool(params?.name, params?.arguments ?? {}, id);
        return send({ id, result: { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] } });
      } catch (e) {
        return send({ id, result: { isError: true, content: [{ type: "text", text: `Bug Me: ${e instanceof Error ? e.message : String(e)}` }] } });
      }
    }
    send({ id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (e) {
    send({ id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
  }
}

/** Claude Code's tool prefix for a server name (docs/STAGE-8.md). The Worker checks it against the name. */
const toolPrefix = (name) => `mcp__${name.replace(/[^A-Za-z0-9_-]/g, "_")}`;

const STATUS = [
  [/connected/i, "connected"],
  [/needs auth/i, "needs authentication"],
  [/not configured/i, "not configured"],
];

/**
 * The names and statuses `claude mcp list` prints ("name: target - ✔ Connected"). Only the name and the
 * status are kept; the target (a command or URL) is dropped here and never sent.
 */
export function parseMcpList(out) {
  const servers = [];
  for (const line of out.split("\n")) {
    const sep = line.indexOf(": ");
    const dash = line.lastIndexOf(" - ");
    if (sep <= 0 || dash < sep) continue;
    const name = line.slice(0, sep).trim();
    const status = STATUS.find(([re]) => re.test(line.slice(dash + 3)))?.[1] ?? "failed";
    if (!name || name.length > 80 || servers.some((s) => s.prefix === toolPrefix(name))) continue;
    servers.push({ name, prefix: toolPrefix(name), status });
  }
  // Connected servers first, so a long list keeps the usable ones.
  return servers.sort((a, b) => (a.status === "connected" ? 0 : 1) - (b.status === "connected" ? 0 : 1)).slice(0, 80);
}

/** Skill names: each directory under ~/.claude/skills (to three levels) that holds a SKILL.md. */
export function skillNames(root = join(homedir(), ".claude", "skills"), depth = 0) {
  let names = [];
  let entries = [];
  try {
    entries = readdirSync(root);
  } catch {
    return names;
  }
  if (entries.includes("SKILL.md")) names.push(basename(root));
  if (depth < 3) for (const e of entries) {
    const p = join(root, e);
    try {
      if (statSync(p).isDirectory()) names = names.concat(skillNames(p, depth + 1));
    } catch {}
  }
  return [...new Set(names)].filter((n) => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(n)).slice(0, 120);
}

async function syncCatalog() {
  process.stderr.write("Reading `claude mcp list` (it checks each server, so this takes a moment)…\n");
  const out = execFileSync("claude", ["mcp", "list"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 180_000 });
  const catalog = { servers: parseMcpList(out), skills: skillNames() };
  const r = await call("POST", "/api/me/catalog", catalog);
  process.stdout.write(`Synced ${r.servers} MCP servers and ${r.skills} skills to Bug Me.\n`);
}

function startServer() {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ id: null, error: { code: -32700, message: "parse error" } });
    }
    void handle(msg);
  });
}

// Run only when started directly, so tests can import parseMcpList.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv[2] === "sync-catalog") {
    syncCatalog().catch((e) => {
      process.stderr.write(`sync-catalog failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    });
  } else {
    startServer();
  }
}
