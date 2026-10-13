// Dispatch with the real Claude CLI (docs/STAGE-8.md): a brief drafted on a local Worker (the
// deterministic stand-in, a throwaway LIVE_TOKEN), its generated command run headless with Haiku,
// and the session's own ask and report checked on the stored brief.
//
// The generated command runs as built, with only these added in front of its arguments:
//   -p, --output-format json  headless, so it ends and reports its cost;
//   --mcp-config/--strict-mcp-config  Bug Me's server pointed at the local Worker (never the real one);
//   --allowedTools  `date` and Bug Me's tools, which a headless run can't be asked to approve.
//
// Run with `npm run smoke:dispatch`. Spends a few cents of Haiku on the developer's own Claude login.

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Brief, type Catalog, buildCommand, shellQuote } from "../src/shared/dispatch";

const PORT = 8807;
const BASE = `http://localhost:${PORT}`;
const OWNER_KEY = randomBytes(32).toString("base64url");
const STATE = `.wrangler/smoke-dispatch-${process.pid}`;
const LIVE_VAR = "LIVE_TOKEN";
/** Blanked, so a developer's .dev.vars key can't make the Worker spend. */
const NO_KEY_VAR = "ANTHROPIC_API_KEY";
const work = mkdtempSync(join(tmpdir(), "bugme-dispatch-"));
const procs: ReturnType<typeof spawn>[] = [];

function cleanup() {
  for (const p of procs) p.kill();
  rmSync(STATE, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}
function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  cleanup();
  process.exit(1);
}
const ok = (msg: string) => console.log(`ok   ${msg}`);
// However the run ends (a thrown error included), the local Worker and the scratch directory go.
process.on("exit", cleanup);

async function owner<T>(path: string, body?: unknown, retried = false): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${BASE}${path}`, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${OWNER_KEY}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    // After the session's minutes of quiet, the first request can land on a connection the local
    // Worker has dropped; one retry tells that apart from a Worker that is gone.
    if (retried) fail(`${path}: ${e instanceof Error ? `${e.message} (${String((e as { cause?: unknown }).cause)})` : String(e)}`);
    console.log(`note ${path}: ${e instanceof Error ? String((e as { cause?: unknown }).cause ?? e.message) : String(e)}; retrying once`);
    return owner<T>(path, body, true);
  }
  const data = await r.json();
  if (!r.ok) fail(`${path}: ${r.status} ${(data as { error?: string }).error}`);
  return data as T;
}

if (await fetch(`${BASE}/`).then(() => true, () => false)) fail(`port ${PORT} is already in use`);
const w = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--persist-to", STATE, "--var", "FAKE_MODEL:1", "--var", `SEAL_KEY:${randomBytes(32).toString("base64")}`, "--var", `${LIVE_VAR}:${OWNER_KEY}`, "--var", `${NO_KEY_VAR}:`], { stdio: ["ignore", process.env.SMOKE_LOG ? "inherit" : "ignore", process.env.SMOKE_LOG ? "inherit" : "ignore"] });
procs.push(w);
for (let i = 0; ; i++) {
  if (await fetch(`${BASE}/api/queue`).then((r) => r.ok, () => false)) break;
  if (i > 60) fail("the local Worker didn't start");
  await new Promise((r) => setTimeout(r, 1000));
}
ok("local Worker up on the stand-in, with a throwaway LIVE_TOKEN");

const catalog: Catalog = { servers: [{ name: "bugme", prefix: "mcp__bugme", status: "connected" }], skills: [] };
await owner("/api/me/catalog", catalog);
const task =
  "Quick demo: write a file hello.txt containing the single word hello. Before writing it, ask with ask_bug_me (wait_minutes 0) whether it should say hello or hi; if the answer is pending, use hello.";
const { brief: drafted } = await owner<{ brief: Brief }>("/api/me/dispatch", { task });
const { brief } = await owner<{ brief: Brief }>(`/api/me/briefs/${drafted.id}/dispatched`, {
  model: "claude-haiku-5-5",
  effort: "low",
  permission_mode: "acceptEdits",
  estimate_minutes: 5,
  budget_usd: 0.2,
  tools_off: [],
});
ok(`brief ${brief.id} drafted and copied (Haiku, low effort, acceptEdits)`);

const mcpConfig = JSON.stringify({
  mcpServers: { bugme: { command: "node", args: [resolve("mcp/bugme.mjs")], env: Object.fromEntries([["BUGME_URL", BASE], ["BUGME_TOKEN", OWNER_KEY]]) } },
});
const extra = ["-p", "--output-format", "json", "--mcp-config", shellQuote(mcpConfig), "--strict-mcp-config", "--allowedTools", shellQuote("Bash(date:*)"), shellQuote("mcp__bugme")].join(" ");
const command = buildCommand(brief, catalog);
if (!command.startsWith("claude ")) fail("the command doesn't start with claude");
const run = command.replace(/^claude /, `claude ${extra} `);
let out: string;
try {
  out = execFileSync("zsh", ["-c", run], { cwd: work, encoding: "utf8", timeout: 300_000, stdio: ["ignore", "pipe", "inherit"] });
} catch (e) {
  fail(`the generated command failed: ${e instanceof Error ? e.message : String(e)}`);
}
const result = JSON.parse(out) as { total_cost_usd?: number; is_error?: boolean };
if (result.is_error) fail(`the session ended in an error: ${out.slice(0, 400)}`);
ok(`the generated command ran a real session ($${(result.total_cost_usd ?? 0).toFixed(3)})`);

const file = join(work, "hello.txt");
if (!existsSync(file) || !/\bhello\b/i.test(readFileSync(file, "utf8"))) fail("the session didn't write hello.txt");
const after = (await owner<{ briefs: Brief[] }>("/api/me/briefs")).briefs.find((b) => b.id === brief.id);
if (!after?.report) fail(`the session didn't report on its brief: ${JSON.stringify(after)}`);
if ((after.asks ?? 0) < 1) fail("the session's ask didn't carry the brief id");
ok(`the session asked about it ${after.asks}× and reported "${after.report.outcome}" (${after.report.scope}): ${after.report.summary}`);

cleanup();
console.log("smoke:dispatch passed");
