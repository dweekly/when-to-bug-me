// End-to-end tests: Playwright against `wrangler dev` with the deterministic fake model, so the whole
// page and Worker run as deployed but no API key or money is involved. It starts its own server on
// port 8799 (8787 is left to a developer's own `wrangler dev`). Chromium only, at desktop and phone size (plus a
// 320px project for stage 2's no-horizontal-scroll check).
import { defineConfig } from "@playwright/test";
import { randomBytes } from "node:crypto";

const PORT = 8799;
/** A second server with no fake model and no API key: the recorded Claude run, as a keyless deployment serves it. */
const RECORDED_PORT = 8798;
/** A throwaway sealing key per test run, so a fresh clone needs no .dev.vars to run the suite. */
const SEAL_KEY = randomBytes(32).toString("base64");

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
      command: `npm run build && npx wrangler dev --var FAKE_MODEL:1 --var SEAL_KEY:${SEAL_KEY} --port ${PORT} --persist-to .wrangler/e2e-state`,
      url: `http://localhost:${PORT}/api/queue`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // Neither the fake model nor an Anthropic key, so only recorded answers. Isolated state, its own seal key.
      command: `npx wrangler dev --var SEAL_KEY:${SEAL_KEY} --port ${RECORDED_PORT} --persist-to .wrangler/e2e-recorded-state`,
      url: `http://localhost:${RECORDED_PORT}/api/queue`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  projects: [
    { name: "desktop", testIgnore: /tours\.spec\.ts/, use: { viewport: { width: 1440, height: 1000 } } },
    { name: "phone", testIgnore: /tours\.spec\.ts/, use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    // Every tour, start to finish, on the recorded run with no key: what a reviewer gets from a keyless deploy.
    { name: "recorded-desktop", testMatch: /tours\.spec\.ts/, use: { baseURL: `http://localhost:${RECORDED_PORT}`, viewport: { width: 1440, height: 1000 } } },
    { name: "recorded-phone", testMatch: /tours\.spec\.ts/, use: { baseURL: `http://localhost:${RECORDED_PORT}`, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    // The narrowest phone the layout promises (no horizontal scroll at 320px); only stage 2's layout check.
    { name: "narrow", testMatch: /stage2\.spec\.ts/, grep: /@narrow/, use: { viewport: { width: 320, height: 700 }, isMobile: true, hasTouch: true } },
  ],
});
