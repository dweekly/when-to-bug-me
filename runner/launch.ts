// Launching a brief (docs/STAGE-9.md): which repos it may go into, the exact `claude --bg` argv, and
// finding the session again. Every path comes from the server-side repo list, never from the browser.
import { type ChildProcess, execFile } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { RUNNER_LAUNCH_TIMEOUT_MS } from "../src/shared/constants";
import { type Brief, type Catalog, REPO_NAME_RE, commandArgs, shellQuote } from "../src/shared/dispatch";

export class LaunchError extends Error {}

export interface Repo {
  name: string;
  /** Claude Code has been opened there and trusted; `--bg` refuses a repo that hasn't. */
  trusted: boolean;
}

/** Directories Claude Code trusts, from its own config (read, never written). */
export function trustedDirs(claudeJson = join(homedir(), ".claude.json")): Set<string> {
  try {
    const projects = (JSON.parse(readFileSync(claudeJson, "utf8")) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> }).projects ?? {};
    return new Set(Object.entries(projects).filter(([, v]) => v?.hasTrustDialogAccepted).map(([k]) => k));
  } catch {
    return new Set();
  }
}

/** A git checkout (its own .git directory, not a worktree or a symlink) directly under the dev root. */
function isRepo(devRoot: string, name: string): boolean {
  if (!REPO_NAME_RE.test(name)) return false;
  try {
    const p = join(devRoot, name);
    return lstatSync(p).isDirectory() && lstatSync(join(p, ".git")).isDirectory();
  } catch {
    return false;
  }
}

export function listRepos(devRoot: string, trusted = trustedDirs()): Repo[] {
  let names: string[] = [];
  try {
    names = readdirSync(devRoot);
  } catch {
    return [];
  }
  return names
    .filter((n) => isRepo(devRoot, n))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, trusted: trusted.has(join(devRoot, name)) || trusted.has(realpathSync(join(devRoot, name))) }));
}

/** The repo's real path, or a LaunchError saying why not. */
export function resolveRepo(devRoot: string, name: string, trusted = trustedDirs()): string {
  if (!isRepo(devRoot, name)) throw new LaunchError(`${name} isn't a git repo in your dev folder`);
  const root = realpathSync(devRoot);
  const real = realpathSync(join(devRoot, name));
  if (!real.startsWith(root + sep)) throw new LaunchError(`${name} isn't a git repo in your dev folder`);
  if (!trusted.has(real) && !trusted.has(join(devRoot, name))) throw new LaunchError(`Claude Code doesn't trust ${name} yet: run \`claude\` there once`);
  return real;
}

/** A launch's session and worktree name: the brief and the attempt, so a retry never meets an older one. */
export const sessionName = (briefId: string, attempt: string) => `bugme-${briefId}-${attempt}`;

/**
 * Bug Me's server for launched sessions: this runner, with its token stated outright so it never falls
 * back to the keychain's (hosted) one. Only `bugme` is defined; the person's other servers stay on.
 * A `--mcp-config` entry named `bugme` replaces the user-scope one (checked 2026-10-14).
 */
export function writeMcpConfig(path: string, repoRoot: string, port: number, token: string): void {
  const config = {
    mcpServers: {
      bugme: {
        command: process.execPath,
        args: [join(repoRoot, "mcp", "bugme.mjs")],
        env: Object.fromEntries([
          ["BUGME_URL", `http://127.0.0.1:${port}`],
          ["BUGME_TOKEN", token],
        ]),
      },
    },
  };
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
}

/** `claude --bg …`: the brief's own arguments (shared with Copy command), ending with `--` and the brief. */
export function launchArgs(b: Brief, c: Catalog, mcpConfigPath: string, attempt: string): string[] {
  const name = sessionName(b.id, attempt);
  return ["--bg", "--worktree", name, "-n", name, "--mcp-config", mcpConfigPath, ...commandArgs(b, c).slice(1)];
}

/** The id `claude --bg` prints: "backgrounded · 4e653586 · <name>". */
export function backgroundId(stdout: string): string | undefined {
  return stdout.match(/backgrounded\s*·\s*([a-z0-9-]{4,64})\s*·/)?.[1];
}

/** Helper processes in flight (mcp list, agents, open): stopped with the runner. */
const helpers = new Set<ChildProcess>();

export function run(bin: string, args: string[], cwd: string, timeout = RUNNER_LAUNCH_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { cwd, timeout, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      helpers.delete(child);
      if (err) reject(new LaunchError("claude failed"));
      else resolve(stdout);
    });
    // `claude --bg` hands its session to Claude Code's own background service and returns; it isn't a
    // helper, and the session it starts is the person's, so it's never stopped here.
    if (args[0] !== "--bg") helpers.add(child);
  });
}

/** Stop every helper still running (the runner is shutting down). */
export function stopHelpers(): void {
  for (const c of helpers) c.kill("SIGKILL");
  helpers.clear();
}

/** A background session as `claude agents --json --all` reports it (code.claude.com/docs/en/agent-view). */
export interface Session {
  id: string;
  name: string;
  /** busy, waiting or idle, while the process is alive. */
  status?: string;
  /** working, blocked (needs the person), done, failed or stopped. */
  state?: string;
  /** When status is waiting: permission prompt, input needed, sandbox request, worker request, dialog open. */
  waitingFor?: string;
  cwd?: string;
}

/** Bug Me's sessions from `claude agents --json --all`: only those named bugme-<brief id>-<attempt>. */
export function parseAgents(json: string): Session[] {
  let rows: unknown;
  try {
    rows = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => (r ?? {}) as Record<string, unknown>)
    .filter((r) => typeof r.id === "string" && typeof r.name === "string" && /^bugme-b-[a-z0-9]{10}-[a-z0-9]{8,32}$/.test(r.name))
    .map((r) => ({
      id: r.id as string,
      name: r.name as string,
      ...(typeof r.status === "string" ? { status: r.status } : {}),
      ...(typeof r.state === "string" ? { state: r.state } : {}),
      ...(typeof r.waitingFor === "string" ? { waitingFor: r.waitingFor } : {}),
      ...(typeof r.cwd === "string" ? { cwd: r.cwd } : {}),
    }));
}

export async function sessions(bin: string, cwd: string): Promise<Session[]> {
  return parseAgents(await run(bin, ["agents", "--json", "--all"], cwd));
}

/**
 * "Do it with me" (docs/STAGE-9.md): a guide, not a doer. It waits for the person to say they're at the
 * Mac, points the way in Chrome, and stops before anything that shows or takes a secret.
 */
export function walkPrompt(b: Brief, item: number): string {
  const p = b.prerequisites[item];
  const steps = b.walks?.find((w) => w.item === item && w.what === p.what)?.steps ?? [];
  return [
    `You're helping a person do one thing themselves before an AI coding session starts on "${b.headline}" (${b.goal}).`,
    `What they need to do: ${p.what}${p.why ? ` (why: ${p.why})` : ""}.`,
    steps.length ? `Bug Me suggested these steps:\n${steps.map((s, i) => `${i + 1}. ${s.text}${s.url ? ` (${s.url})` : ""}`).join("\n")}` : "",
    "",
    "How to help:",
    "- First ask them to say \"ready\" when they're at this Mac with Chrome open, and wait for it.",
    "- Then use Claude in Chrome to open the right page and tell them what to click. They do the clicking and the typing.",
    "- Stop before any page or step that would show or take a secret (a token, key, password or recovery code). Tell them that part is theirs, point them to the numbered step, and don't look at that page.",
    "- Never ask them to type or paste a secret into this chat.",
    "- When they say it's done, tell them to tick the box in Bug Me, and stop.",
  ]
    .filter((x) => x !== undefined)
    .join("\n");
}

/** Write the walk's prompt and a fixed .command that runs it; no step text is ever on a command line. */
export function writeWalk(dir: string, claudeBin: string, prompt: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "prompt.txt"), prompt, { mode: 0o600 });
  const script = join(dir, "walk.command");
  writeFileSync(script, `#!/bin/sh\ncd ${shellQuote(dir)} && exec ${shellQuote(claudeBin)} --chrome --no-session-persistence -- "$(cat prompt.txt)"\n`, { mode: 0o700 });
  return script;
}
