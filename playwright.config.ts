// End-to-end tests: Playwright against `wrangler dev` with the deterministic fake model, so the whole
// page and Worker run as deployed but no API key or money is involved. It starts its own server on
// port 8799 (8787 is left to a developer's own `wrangler dev`). Chromium only, at desktop and phone size (plus a
// 320px project for stage 2's no-horizontal-scroll check).
import { defineConfig } from "@playwright/test";
import { randomBytes } from "node:crypto";

/** Shifts every port below, so several worktrees can run the suite at once (E2E_PORT_OFFSET=100 npx playwright test). */
const OFFSET = Number(process.env.E2E_PORT_OFFSET ?? 0);
const PORT = 8799 + OFFSET;
/** A second server with no fake model and no API key: the recorded Claude run, as a keyless deployment serves it. */
const RECORDED_PORT = 8798 + OFFSET;
/** The runner (docs/STAGE-9.md) on stubs: its Worker takes the next port and its inspector the one after. */
const RUNNER_PORT = 8793 + OFFSET;
/** A throwaway sealing key per test run, so a fresh clone needs no .dev.vars to run the suite. */
const SEAL_KEY = randomBytes(32).toString("base64");
/**
 * A throwaway owner key for the live queue (docs/STAGE-7.md). Set in the environment once, by the
 * runner, so the workers (which load this file again) read the same value; live.spec.ts uses it.
 */
process.env.BUGME_E2E_LIVE_TOKEN ??= randomBytes(32).toString("base64url");
const liveKey = process.env.BUGME_E2E_LIVE_TOKEN;
const LIVE_VAR = "LIVE_TOKEN";
/** Wrangler vars the recorded server overrides to empty, so a developer's .dev.vars (which may hold a
 *  real Anthropic key, or turn on the fake model) cannot leak into the keyless run. */
const BLANKED = ["ANTHROPIC_API_KEY", "FAKE_MODEL"].map((name) => `--var ${name}:`).join(" ");

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    browserName: "chromium",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      // Its own Durable Object state directory, so it never shares (and locks) a developer's wrangler dev state.
      command: `npm run build && npx wrangler dev --var FAKE_MODEL:1 --var SEAL_KEY:${SEAL_KEY} --var ${LIVE_VAR}:${liveKey} --port ${PORT} --persist-to .wrangler/e2e-state`,
      url: `http://localhost:${PORT}/api/queue`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // Neither the fake model nor an Anthropic key, so only recorded answers. Isolated state, its own seal key.
      command: `npx wrangler dev --var SEAL_KEY:${SEAL_KEY} ${BLANKED} --port ${RECORDED_PORT} --persist-to .wrangler/e2e-recorded-state`,
      url: `http://localhost:${RECORDED_PORT}/api/queue`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // The runner with the stand-in model, a stub claude and a stub open (tests/fixtures/start-runner.mjs).
      command: `npx esbuild runner/main.ts --bundle --platform=node --format=esm --packages=external --external:../mcp/bugme.mjs --outfile=dist/runner.mjs --log-level=warning && BUGME_RUNNER_PORT=${RUNNER_PORT} node tests/fixtures/start-runner.mjs`,
      url: `http://localhost:${RUNNER_PORT}/me`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  projects: [
    { name: "desktop", testIgnore: /(tours.*|runner)\.spec\.ts/, use: { viewport: { width: 1440, height: 1000 } } },
    { name: "phone", testIgnore: /(tours.*|runner)\.spec\.ts/, use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    // Every tour, start to finish, on the recorded run with no key: what a reviewer gets from a keyless deploy.
    { name: "recorded-desktop", testMatch: /tours.*\.spec\.ts/, use: { baseURL: `http://localhost:${RECORDED_PORT}`, viewport: { width: 1440, height: 1000 } } },
    { name: "recorded-phone", testMatch: /tours.*\.spec\.ts/, use: { baseURL: `http://localhost:${RECORDED_PORT}`, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    // The runner, owner-only (its specs only). One project: its tests share the runner's state and stubs,
    // so they run in order, and the phone layout is checked inside them.
    { name: "runner", testMatch: /runner\.spec\.ts/, use: { baseURL: `http://localhost:${RUNNER_PORT}`, viewport: { width: 1440, height: 1000 } } },
    // The narrowest phone the layout promises (no horizontal scroll at 320px): the layout checks only.
    { name: "narrow", testMatch: /(stage(2|6[ef]?|8|10)|settled|reflection)\.spec\.ts/, grep: /@narrow/, use: { viewport: { width: 320, height: 700 }, isMobile: true, hasTouch: true } },
  ],
});
