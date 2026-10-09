// Unit tests only. Playwright specs live in tests/e2e and run under `npm run e2e`, so they are
// excluded here. Unit tests run in Node and must not import src/worker/index.ts or model.ts, which
// pull in the Workers-only `cloudflare:workers` module (via spend.ts).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});
