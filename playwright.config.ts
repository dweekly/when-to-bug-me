// End-to-end tests: Playwright against `wrangler dev` with the deterministic fake model, so the whole
// page and Worker run as deployed but no API key or money is involved. It starts its own server on
// port 8799 (8787 is left to a developer's own `wrangler dev`). Chromium only, at desktop and phone size.
import { defineConfig } from "@playwright/test";
import { randomBytes } from "node:crypto";

const PORT = 8799;
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
  webServer: {
    // Its own Durable Object state directory, so it never shares (and locks) a developer's wrangler dev state.
    command: `npm run build && npx wrangler dev --var FAKE_MODEL:1 --var SEAL_KEY:${SEAL_KEY} --port ${PORT} --persist-to .wrangler/e2e-state`,
    url: `http://localhost:${PORT}/api/queue`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    { name: "phone", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
