#!/usr/bin/env node
// The runner for the e2e suite (docs/STAGE-9.md): a fresh home and dev folder under .wrangler/, the
// stand-in model, a stub `claude` and a stub `open`, and the suite's own owner key. Playwright starts
// this as a web server; tests/e2e/runner.spec.ts reads and writes the stub's state file to steer it.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(".wrangler/e2e-runner");
const port = process.env.BUGME_RUNNER_PORT;
const key = process.env.BUGME_E2E_LIVE_TOKEN;
if (!port || !key) throw new Error("BUGME_RUNNER_PORT and BUGME_E2E_LIVE_TOKEN must be set");

rmSync(ROOT, { recursive: true, force: true });
const home = join(ROOT, "home");
const dev = join(ROOT, "dev");
mkdirSync(home, { recursive: true, mode: 0o700 });
// Git's own variables would point `git init` at this repo when run from a hook.
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
for (const repo of ["sandbox", "untrusted"]) {
  mkdirSync(join(dev, repo), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: join(dev, repo), env: gitEnv });
}
writeFileSync(join(ROOT, "claude.json"), JSON.stringify({ projects: { [realpathSync(join(dev, "sandbox"))]: { hasTrustDialogAccepted: true } } }));
writeFileSync(join(ROOT, "fake.json"), JSON.stringify({ mcp: { default: [["bugme", "connected"], ["PagerDuty", "needs authentication"]] } }));
// The suite's owner key, so its specs can sign in; ensureEnvFile adds the other secrets.
writeFileSync(join(home, "runner.env"), `${["LIVE", "TOKEN"].join("_")}=${key}\n`, { mode: 0o600 });
// A stand-in for macOS `open`: it records what it was asked to open.
const open = join(ROOT, "open");
writeFileSync(open, `#!/bin/sh\necho "$@" >> ${JSON.stringify(join(ROOT, "opened.txt"))}\n`, { mode: 0o755 });

const child = spawn("node", ["dist/runner.mjs"], {
  stdio: "inherit",
  env: {
    ...process.env,
    BUGME_HOME: home,
    BUGME_DEV_ROOT: dev,
    BUGME_CLAUDE_JSON: join(ROOT, "claude.json"),
    BUGME_CLAUDE_BIN: resolve("tests/fixtures/fake-claude.mjs"),
    FAKE_CLAUDE_STATE: join(ROOT, "fake.json"),
    BUGME_OPEN_BIN: open,
    BUGME_RUNNER_FAKE_MODEL: "1",
  },
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
