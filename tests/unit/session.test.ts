import { describe, expect, it } from "vitest";
import { SESSION_TTL_SECONDS, issueSession, sessionValid } from "../../src/worker/session";

const KEY = "a-test-seal-key";

describe("session tokens", () => {
  it("accepts a token it issued, before expiry", async () => {
    const now = Date.UTC(2026, 9, 9, 12);
    const t = await issueSession(KEY, now);
    expect(await sessionValid(KEY, t, now + 1000)).toBe(true);
  });

  it("rejects an expired token", async () => {
    const now = Date.UTC(2026, 9, 9, 12);
    const t = await issueSession(KEY, now);
    expect(await sessionValid(KEY, t, now + (SESSION_TTL_SECONDS + 1) * 1000)).toBe(false);
  });

  it("rejects a token signed under another key", async () => {
    const t = await issueSession("another-key");
    expect(await sessionValid(KEY, t)).toBe(false);
  });

  it("rejects a token whose expiry was extended", async () => {
    const t = await issueSession(KEY);
    const [v, exp, sig] = t.split(".");
    expect(await sessionValid(KEY, `${v}.${Number(exp) + 86400}.${sig}`)).toBe(false);
  });

  it("rejects missing and malformed tokens", async () => {
    for (const bad of [null, "", "v1", "v1.x.y", "v2.1.abc", `v1.${2e9}.${"z".repeat(64)}`]) {
      expect(await sessionValid(KEY, bad)).toBe(false);
    }
  });
});
