// The runner end to end with the real Claude CLI (docs/STAGE-9.md): a runner on a throwaway home drafts
// a brief on the person's Claude login, launches it into a sandbox repo exactly as the page does, and the
// session asks Bug Me, gets the owner's answer, carries on, and reports, all on the runner (never the
// user-scope bugme server). Then its session and worktree, and only those, are removed.
//
// Setup, once: mkdir -p ~/dev/bugme-sandbox && cd ~/dev/bugme-sandbox && git init && git commit --allow-empty -m init
// then run `claude` there and accept the trust prompt (`--bg` refuses an untrusted repo).
//
// Run with `npm run smoke:runner`. Spends a few cents on the developer's own Claude login (Opus drafts
// and routes; the session itself runs on Haiku).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Brief } from "../src/shared/dispatch";

const PORT = 8830;
const BASE = `http://localhost:${PORT}`;
const REPO = process.env.BUGME_SMOKE_REPO ?? "bugme-sandbox";
const DEV = resolve(process.env.BUGME_DEV_ROOT ?? join(homedir(), "dev"));
const home = mkdtempSync(join(tmpdir(), "bugme-runner-home-"));
let sessionId: string | undefined;
let runner: ReturnType<typeof spawn> | undefined;

function cleanup() {
  if (sessionId) {
    try {
      execFileSync("claude", ["rm", sessionId], { cwd: join(DEV, REPO), stdio: "ignore" });
    } catch {}
  }
  if (runner?.pid) {
    try {
      process.kill(runner.pid, "SIGTERM");
    } catch {}
  }
  rmSync(home, { recursive: true, force: true });
}
function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  cleanup();
  process.exit(1);
}
const ok = (msg: string) => console.log(`ok   ${msg}`);
process.on("exit", cleanup);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(join(DEV, REPO, ".git"))) fail(`no ${REPO} repo under ${DEV}; see the setup at the top of this script`);
if (await fetch(`${BASE}/`).then(() => true, () => false)) fail(`port ${PORT} is already in use`);

runner = spawn("node", ["dist/runner.mjs"], {
  env: { ...process.env, BUGME_HOME: home, BUGME_RUNNER_PORT: String(PORT), BUGME_DEV_ROOT: DEV },
  stdio: ["ignore", "pipe", process.env.SMOKE_LOG ? "inherit" : "ignore"],
});
let banner = "";
runner.stdout!.on("data", (d) => (banner += String(d)));
for (let i = 0; !banner.includes("Bug Me is running"); i++) {
  if (i > 120 || runner.exitCode !== null) fail("the runner didn't start (SMOKE_LOG=1 shows why)");
  await sleep(1000);
}
const OWNER_VAR = "LIVE_TOKEN";
const key = readFileSync(join(home, "runner.env"), "utf8").match(new RegExp(`^${OWNER_VAR}=(.+)$`, "m"))![1];
ok("runner up on a throwaway home");

async function owner<T>(path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const r = await fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, data: (await r.json()) as T };
}

const status = await owner<{ repos: { name: string; trusted: boolean }[] }>("/runner/status");
const repo = status.data.repos?.find((r) => r.name === REPO);
if (!repo?.trusted) fail(`${REPO} isn't trusted by Claude Code yet; see the setup at the top of this script`);

const task =
  "Smoke test: write a file greeting.txt containing a single word. Before writing it, use ask_bug_me (wait_minutes 5) to ask which word, with options A 'hello' and B 'hi', and use the answer.";
const drafted = await owner<{ brief: Brief; source: string; error?: string }>("/api/me/dispatch", { task });
if (drafted.status !== 200 || drafted.data.source !== "live") fail(`drafting on the Claude login: ${drafted.status} ${drafted.data.error ?? drafted.data.source}`);
const b = drafted.data.brief;
ok(`drafted on the Claude login: "${b.headline}"`);

const ticked = b.prerequisites.map((_, i) => i);
const copied = await owner(`/api/me/briefs/${b.id}/dispatched`, { model: "claude-haiku-5-5", effort: "low", permission_mode: "acceptEdits", estimate_minutes: 5, budget_usd: 0.5, tools_off: [], ticked });
if (copied.status !== 200) fail(`saving the setup: ${copied.status}`);
const launched = await owner<{ launch?: { state: string; session_id?: string }; error?: string }>("/runner/launch", { brief_id: b.id, repo: REPO });
if (launched.status !== 200 || launched.data.launch?.state !== "running") fail(`launch: ${launched.status} ${launched.data.error ?? JSON.stringify(launched.data)}`);
sessionId = launched.data.launch.session_id;
ok(`launched as background session ${sessionId} in a worktree of ${REPO}`);

// The session's ask reaches this runner's queue; the owner answers it as the page does.
type Q = { decisions: { id: string; options: { key: string; label: string }[] }[]; cards: { id: string; sealed: string; route: string }[] };
let answered = false;
for (let i = 0; i < 90 && !answered; i++) {
  await sleep(4000);
  const q = (await owner<Q>("/api/me/queue")).data;
  const d = q.decisions.find((x) => x.options.some((o) => /\bhi\b/i.test(o.label)));
  const card = d && q.cards.find((c) => c.id === d.id);
  if (!d || !card) continue;
  const hi = d.options.find((o) => /\bhi\b/i.test(o.label) && !/hello/i.test(o.label))!;
  const fin = await owner<{ send_down?: string }>("/api/me/answer", { id: d.id, sealed: card.sealed, choice: hi.key, stage: "final" });
  const res = await owner("/api/me/resolve", { id: d.id, outcome: "option", choice: hi.key, reason: "Shorter is friendlier here.", instruction: fin.data.send_down });
  if (res.status !== 200) fail(`answering: ${res.status}`);
  answered = true;
  ok(`the session's ask reached the runner (${card.route}); answered "${hi.label}"`);
}
if (!answered) fail("the session's ask never reached the runner's queue");

let after: Brief | undefined;
for (let i = 0; i < 90; i++) {
  await sleep(4000);
  after = (await owner<{ briefs: Brief[] }>("/api/me/briefs")).data.briefs.find((x) => x.id === b.id);
  if (after?.report) break;
}
if (!after?.report) fail("the session never reported on its brief");
if ((after.asks ?? 0) < 1) fail("the session's ask didn't carry the brief id");
ok(`reported "${after.report.outcome}" (${after.report.scope}) with ${after.asks} ask(s): ${after.report.summary}`);

const sessions = JSON.parse(execFileSync("claude", ["agents", "--json", "--all"], { encoding: "utf8" })) as { id: string; cwd?: string }[];
const cwd = sessions.find((s) => s.id === sessionId)?.cwd;
const file = cwd && join(cwd, "greeting.txt");
if (!file || !existsSync(file) || !/^\s*hi\s*$/i.test(readFileSync(file, "utf8"))) fail(`the session didn't write the owner's answer to greeting.txt (${file})`);
ok("the session carried on with the owner's answer: greeting.txt says hi");

cleanup();
sessionId = undefined;
console.log("smoke:runner passed");
