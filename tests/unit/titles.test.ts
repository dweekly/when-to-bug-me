// src/shared/titles.ts: the fast model's emoji and short titles (docs/STAGE-6.md, 1b), checked before
// they are shown or recorded.
import { describe, expect, it } from "vitest";
import { MAX_TITLE_WORDS } from "../../src/shared/constants";
import { fakeTitles, isOneEmoji, parseTitles } from "../../src/shared/titles";
import { decision, decisions } from "./helpers";

const d = decision("branch-cleanup");
const ok = { emoji: "🌿", title: "Delete old merged branches", done: { A: "Deleted 41 merged branches", B: "Kept the old branches" } };

describe("parseTitles", () => {
  it("accepts one emoji, a short title and a short done line per option", () => {
    expect(parseTitles(ok, d)).toEqual(ok);
  });
  it("counts a joined or flag emoji as one, and refuses none, two or text", () => {
    expect(isOneEmoji("✈️")).toBe(true);
    expect(isOneEmoji("👩‍💻")).toBe(true);
    expect(isOneEmoji("🇺🇸")).toBe(true);
    for (const bad of ["", "🌿🌿", "branch", "🌿 x"]) expect(() => parseTitles({ ...ok, emoji: bad }, d), bad).toThrow(/emoji/);
  });
  it(`refuses a title or done line over ${MAX_TITLE_WORDS} words, or missing`, () => {
    expect(() => parseTitles({ ...ok, title: "one two three four five six seven" }, d)).toThrow(/title/);
    expect(() => parseTitles({ ...ok, done: { A: ok.done.A } }, d)).toThrow(/done\.B/);
  });
  it("drops a final period", () => {
    expect(parseTitles({ ...ok, title: "Delete old merged branches." }, d).title).toBe("Delete old merged branches");
  });
});

describe("fakeTitles, the stand-in", () => {
  it("passes the same checks for every decision", () => {
    for (const x of decisions) expect(() => parseTitles(fakeTitles(x), x), x.id).not.toThrow();
  });
});
