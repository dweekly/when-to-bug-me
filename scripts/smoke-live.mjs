// The live loop, end to end on this machine (docs/STAGE-7.md): a local Worker on the deterministic
// stand-in with a throwaway LIVE_TOKEN, and the real MCP server driven over stdio as Claude Code would.
//
//   1. MCP handshake and tool discovery.
//   2. An ask a rule covers (a free, reversible staging deploy): settled at once, the rule quoted.
//   3. An ask no rule covers (a production deploy): pending, and on the owner's queue.
//   4. The owner answers it through the page's own API path (a conversation turn, the answer, the resolution).
//   5. check_bug_me returns the answer with the owner's reason.
//   6. Sign-in: no credentials is refused; the one-time link sets the cookie; /me serves the app.
//   7. Dispatch (docs/STAGE-8.md): a catalog is synced (a bad one refused), a task becomes a stored
//      brief, Copy records the edits, an ask names the brief, and report_to_bug_me reports on it.
//   8. The Worker goes away while a session waits: the session still gets its ticket, to check later.
//
// Run with `npm run smoke:live`. No API key is used and nothing is spent.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { createInterface } from "node:readline";

const PORT = 8806;
const BASE = `http://localhost:${PORT}`;
const OWNER_KEY = randomBytes(32).toString("base64url");
const LIVE_VAR = "LIVE_TOKEN";
/** Blanked, so a developer's .dev.vars key can't make the smoke spend. */
const NO_KEY_VAR = "ANTHROPIC_API_KEY";
const STATE = `.wrangler/smoke-live-${process.pid}`;
const procs = [];
let worker;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  cleanup();
  process.exit(1);
}
function ok(msg) {
  console.log(`ok   ${msg}`);
}
function cleanup() {
  for (const p of procs) p.kill();
  rmSync(STATE, { recursive: true, force: true });
}

async function startWorker() {
  // Another server on this port would answer instead of ours: refuse rather than test the wrong thing.
  if (await fetch(`${BASE}/`).then(() => true, () => false)) fail(`port ${PORT} is already in use`);
  const w = spawn(
    "npx",
    ["wrangler", "dev", "--port", String(PORT), "--persist-to", STATE, "--var", "FAKE_MODEL:1", "--var", `SEAL_KEY:${randomBytes(32).toString("base64")}`, "--var", `${LIVE_VAR}:${OWNER_KEY}`, "--var", `${NO_KEY_VAR}:`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  procs.push(w);
  worker = w;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/queue`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail("the local Worker didn't start");
}

function startMcp() {
  const m = spawn("node", ["mcp/bugme.mjs"], { env: { ...process.env, BUGME_URL: BASE, ...Object.fromEntries([["BUGME_TOKEN", OWNER_KEY]]), CLAUDE_PROJECT_DIR: "/tmp/smoke-project" }, stdio: ["pipe", "pipe", "inherit"] });
  procs.push(m);
  const waiting = new Map();
  createInterface({ input: m.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  });
  let next = 1;
  return (method, params) =>
    new Promise((resolve, reject) => {
      const id = next++;
      waiting.set(id, resolve);
      m.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => reject(new Error(`${method} timed out`)), 30_000);
    });
}

const owner = (path, body) =>
  fetch(`${BASE}${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${OWNER_KEY}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => {
    const data = await r.json();
    if (!r.ok) fail(`${path}: ${r.status} ${data.error}`);
    return data;
  });

async function toolResult(rpc, name, args) {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.result?.isError) fail(`${name}: ${r.result.content[0].text}`);
  return JSON.parse(r.result.content[0].text);
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

await startWorker();
ok("local Worker up on the stand-in, with a throwaway LIVE_TOKEN");
const rpc = startMcp();

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
if (init.result?.serverInfo?.name !== "bugme") fail("initialize didn't name the bugme server");
const tools = (await rpc("tools/list", {})).result.tools.map((t) => t.name);
if (tools.join() !== "ask_bug_me,report_to_bug_me,check_bug_me") fail(`unexpected tools: ${tools}`);
ok("MCP handshake: tools ask_bug_me, report_to_bug_me and check_bug_me");

const settled = await toolResult(rpc, "ask_bug_me", {
  question: "Deploy the docs site to staging from main?",
  options: [
    { label: "Deploy to staging", reversible: "yes", cost_usd: 0 },
    { label: "Wait", reversible: "yes", cost_usd: 0 },
  ],
  recommended: "Deploy to staging",
  context: "main is green; this only updates the staging docs site.",
  session: "docs refresh",
  wait_minutes: 0,
});
if (settled.status !== "settled" || settled.choice !== "A" || !/^Staging deploys from a commit on main need no permission/.test(settled.rule ?? "") || !settled.ticket) fail(`staging deploy: ${JSON.stringify(settled)}`);
ok(`a rule covers it: settled at once, quoting "${settled.rule}"`);

const pending = await toolResult(rpc, "ask_bug_me", {
  question: "Deploy the new onboarding flow to production now?",
  options: [
    { label: "Deploy to production", pros: "users get it today", reversible: "partly", cost_usd: 0 },
    { label: "Wait for Monday", cons: "a weekend of the old flow", reversible: "yes", cost_usd: 0 },
  ],
  recommended: "Deploy to production",
  context: "Staging has passed; nobody is on call this weekend.",
  session: "onboarding",
  wait_minutes: 0,
});
if (pending.status !== "pending" || !pending.ticket) fail(`production deploy: ${JSON.stringify(pending)}`);
ok(`no rule covers it: pending as ${pending.ticket}, with a note to keep working`);

const q = await owner("/api/me/queue");
const card = q.cards.find((c) => c.id === pending.ticket);
const d = q.decisions.find((x) => x.id === pending.ticket);
if (!q.owner || !card || !d || d.project !== "smoke-project") fail("the pending ask isn't on the owner's queue under its project");
if (q.decisions.some((x) => x.id === settled.ticket) !== true) fail("the settled ask isn't listed for Decided for you");
ok("the owner's queue lists the pending ask (and the settled one) under the session's project");

const reason = "Nobody's on call this weekend to watch it.";
const turn = await owner("/api/me/converse", { id: d.id, card: { route: card.route, why_here: card.why_here }, turns: [{ who: "jordan", text: `Wait for Monday, because ${reason.toLowerCase()}` }] });
if (!turn.reply || turn.source !== "code") fail(`conversation turn: ${JSON.stringify(turn)}`);
const fin = await owner("/api/me/answer", { id: d.id, sealed: card.sealed, choice: "B", stage: "final" });
await owner("/api/me/resolve", { id: d.id, outcome: "option", choice: "B", reason, instruction: fin.send_down });
ok("answered through the page's path: a conversation turn, the answer, the resolution");

const answered = await toolResult(rpc, "check_bug_me", { ticket: pending.ticket });
if (answered.status !== "answered" || answered.choice !== "B" || answered.label !== "Wait for Monday" || answered.reason !== reason) fail(`check_bug_me: ${JSON.stringify(answered)}`);
ok(`check_bug_me: "${answered.label}", because "${answered.reason}"`);

if ((await fetch(`${BASE}/api/me/queue`)).status !== 401) fail("the owner's queue answered without credentials");
const login = await fetch(`${BASE}/api/me/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ k: OWNER_KEY }) });
const cookie = login.headers.get("set-cookie") ?? "";
if (!login.ok || !/HttpOnly/.test(cookie) || cookie.includes(OWNER_KEY)) fail("the login didn't set an HttpOnly cookie without the token in it");
const viaCookie = await fetch(`${BASE}/api/me/queue`, { headers: { cookie: cookie.split(";")[0] } });
const page = await fetch(`${BASE}/me`);
if (!viaCookie.ok || !page.ok || !/<html/i.test(await page.text())) fail("the cookie or the /me page didn't work");
ok("sign-in: refused without credentials; the link sets an HttpOnly cookie; /me serves the app");

const bad = await fetch(`${BASE}/api/me/catalog`, { method: "POST", headers: { authorization: `Bearer ${OWNER_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ servers: [{ name: "x", prefix: "mcp__x$(id)", status: "connected" }], skills: [] }) });
if (bad.status !== 400) fail(`a catalog with a shell prefix wasn't refused: ${bad.status}`);
const synced = await owner("/api/me/catalog", {
  servers: [
    { name: "bugme", prefix: "mcp__bugme", status: "connected" },
    { name: "GitHub", prefix: "mcp__GitHub", status: "connected" },
    { name: "PagerDuty", prefix: "mcp__PagerDuty", status: "needs authentication" },
  ],
  skills: ["frontend-design"],
});
if (synced.servers !== 3) fail(`catalog: ${JSON.stringify(synced)}`);
const drafted = await owner("/api/me/dispatch", { task: "Hook the release bot up to PagerDuty so failed releases page whoever is on call." });
const brief = drafted.brief;
if (!/^b-[a-z0-9]{10}$/.test(brief?.id ?? "") || drafted.source !== "code" || !brief.prerequisites.some((p) => /token/i.test(p.what))) fail(`dispatch: ${JSON.stringify(drafted)}`);
const copied = await owner(`/api/me/briefs/${brief.id}/dispatched`, { model: "claude-haiku-5-5", effort: "low", permission_mode: "plan", estimate_minutes: 20, budget_usd: 1, tools_off: ["mcp__GitHub"] });
if (copied.brief.model !== "claude-haiku-5-5" || !copied.brief.dispatched_at) fail(`dispatched: ${JSON.stringify(copied)}`);
const linked = await toolResult(rpc, "ask_bug_me", {
  question: "Page the whole team or only the on-call person?",
  options: [
    { label: "Only on-call", reversible: "yes", cost_usd: 0 },
    { label: "Whole team", reversible: "yes", cost_usd: 0 },
  ],
  context: "Setting up release alerts.",
  brief: brief.id,
  wait_minutes: 0,
});
const reported = await toolResult(rpc, "report_to_bug_me", { brief: brief.id, outcome: "done", scope: "as briefed", summary: "Wired the bot to PagerDuty. One page goes to on-call." });
const after = (await owner("/api/me/briefs")).briefs.find((b) => b.id === brief.id);
if (!reported.ok || after?.asks !== 1 || after?.report?.outcome !== "done" || after?.model !== "claude-haiku-5-5") fail(`brief after the session: ${JSON.stringify(after)}`);
if (!linked.ticket) fail("the linked ask has no ticket");
ok(`dispatch: brief ${brief.id} drafted, copied with edits, asked about once, reported done`);

const waiting = toolResult(rpc, "ask_bug_me", {
  question: "Rotate the production database password tonight?",
  options: [
    { label: "Rotate tonight", reversible: "no", cost_usd: 0 },
    { label: "Wait for the weekend", reversible: "yes", cost_usd: 0 },
  ],
  context: "A routine rotation.",
  wait_minutes: 1,
});
await new Promise((r) => setTimeout(r, 4000)); // asked, and polling
worker.kill();
const lost = await waiting;
if (lost.status !== "pending" || !lost.ticket || !/check_bug_me/.test(lost.note ?? "")) fail(`a lost poll lost the ticket: ${JSON.stringify(lost)}`);
ok(`the Worker went away mid-wait: the session still has ${lost.ticket}, with a note to check later`);

cleanup();
console.log("smoke:live passed");
