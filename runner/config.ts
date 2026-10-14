// The runner's settings and secrets (docs/STAGE-9.md). The secrets are made on first run into
// <home>/runner.env (mode 0600), which wrangler reads with --env-file; they are never on a command line.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { RUNNER_PORT } from "../src/shared/constants";

export interface RunnerConfig {
  /** Where the runner keeps its state, secrets and generated files (~/.bugme). */
  home: string;
  /** The repos Launch may use: git repos directly under this directory (~/dev). */
  devRoot: string;
  /** This checkout: the Worker, the page and the MCP server come from here. */
  repoRoot: string;
  port: number;
  workerPort: number;
  /** The `claude` executable (tests point this at a stub). */
  claudeBin: string;
  /** Claude Code's config, read (never written) for which directories it trusts. */
  claudeJson: string;
  /** The tailnet name `tailscale serve` answers on, when set: one more allowed Host, over https. */
  tailnetHost?: string;
  ownerKey: string;
  sealKey: string;
  modelKey: string;
}

const ENV_FILE = "runner.env";
/** The Worker's variables: the owner's key (stage 7), the seal key, and the model callback's key. */
const OWNER_VAR = "LIVE_TOKEN";
const MODEL_VAR = "LOCAL_MODEL_TOKEN";
const KEYS = [OWNER_VAR, "SEAL_KEY", MODEL_VAR] as const;

/** KEY=value lines; blank lines and # comments skipped. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** The env file wrangler reads: made with fresh secrets when missing, and any missing secret added. */
export function ensureEnvFile(home: string): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, ENV_FILE);
  const vars = existsSync(path) ? parseEnvFile(readFileSync(path, "utf8")) : {};
  const fresh = (k: (typeof KEYS)[number]) => randomBytes(32).toString(k === "SEAL_KEY" ? "base64" : "base64url");
  let changed = !existsSync(path);
  for (const k of KEYS) {
    if (!vars[k]) {
      vars[k] = fresh(k);
      changed = true;
    }
  }
  if (changed) {
    const lines = [
      "# Bug Me runner (docs/STAGE-9.md). Secrets: keep this file to yourself.",
      "# BUGME_TAILNET_HOST=<name>.<tailnet>.ts.net   (set after `tailscale serve`)",
      ...Object.entries(vars).map(([k, v]) => `${k}=${v}`),
    ];
    writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
  }
  chmodSync(path, 0o600);
  return path;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const home = resolve(env.BUGME_HOME ?? join(homedir(), ".bugme"));
  const vars = parseEnvFile(readFileSync(ensureEnvFile(home), "utf8"));
  const port = Number(env.BUGME_RUNNER_PORT ?? RUNNER_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65534) throw new Error("BUGME_RUNNER_PORT must be a port from 1024 to 65534");
  const tailnetHost = vars.BUGME_TAILNET_HOST?.toLowerCase();
  if (tailnetHost && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(tailnetHost)) throw new Error("BUGME_TAILNET_HOST must be a host name");
  return {
    home,
    devRoot: resolve(env.BUGME_DEV_ROOT ?? join(homedir(), "dev")),
    repoRoot: resolve(env.BUGME_REPO_ROOT ?? process.cwd()),
    port,
    workerPort: port + 1,
    claudeBin: env.BUGME_CLAUDE_BIN ?? "claude",
    claudeJson: resolve(env.BUGME_CLAUDE_JSON ?? join(homedir(), ".claude.json")),
    ...(tailnetHost ? { tailnetHost } : {}),
    ownerKey: vars[OWNER_VAR],
    sealKey: vars.SEAL_KEY,
    modelKey: vars[MODEL_VAR],
  };
}
