// src/shared/fact.ts: validating the fact prompt's answer beyond its JSON shape.

import { describe, expect, it } from "vitest";
import { FactParseError, parseFactOutput } from "../../src/shared/fact";
import { facts } from "./helpers";

const base = { replaces: "", text: "", scope: "all", confirm: "Got it.", may_affect: [] as unknown[] };

describe("parseFactOutput", () => {
  it("accepts 'none' and blanks its text and replaces", () => {
    const out = parseFactOutput({ ...base, kind: "none", text: "ignored", replaces: "F1" }, facts);
    expect(out).toEqual({ kind: "none", replaces: "", text: "", scope: "all", confirm: "Got it.", may_affect: [] });
  });

  it("accepts 'add', trims text, defaults an empty scope to all, and keeps only string ids", () => {
    const out = parseFactOutput(
      { ...base, kind: "add", text: "  No commitments before 8:30am.  ", scope: " ", replaces: "F2", may_affect: ["berlin-sync", 7, null] },
      facts,
    );
    expect(out.kind).toBe("add");
    expect(out.text).toBe("No commitments before 8:30am.");
    expect(out.scope).toBe("all");
    expect(out.replaces).toBe("");
    expect(out.may_affect).toEqual(["berlin-sync"]);
  });

  it("accepts 'replace' naming an existing fact", () => {
    const out = parseFactOutput({ ...base, kind: "replace", replaces: "F1", text: "One small runtime dependency is fine." }, facts);
    expect(out).toMatchObject({ kind: "replace", replaces: "F1", text: "One small runtime dependency is fine." });
  });

  it("rejects 'replace' naming a fact that does not exist", () => {
    expect(() => parseFactOutput({ ...base, kind: "replace", replaces: "F99", text: "Something." }, facts)).toThrow(FactParseError);
    expect(() => parseFactOutput({ ...base, kind: "replace", replaces: "", text: "Something." }, facts)).toThrow(/no existing fact/);
  });

  it("rejects an empty or rambling fact on add and replace", () => {
    expect(() => parseFactOutput({ ...base, kind: "add", text: "   " }, facts)).toThrow(FactParseError);
    expect(() => parseFactOutput({ ...base, kind: "add", text: "x".repeat(241) }, facts)).toThrow(/too long/);
    expect(parseFactOutput({ ...base, kind: "add", text: "x".repeat(240) }, facts).text).toHaveLength(240);
    expect(() => parseFactOutput({ ...base, kind: "replace", replaces: "F1", text: "" }, facts)).toThrow(FactParseError);
  });

  it("rejects an unknown kind, non-objects and non-string fields", () => {
    expect(() => parseFactOutput({ ...base, kind: "update", text: "x" }, facts)).toThrow(FactParseError);
    expect(() => parseFactOutput(null, facts)).toThrow(FactParseError);
    expect(() => parseFactOutput({ ...base, kind: "add", text: "A fine fact.", confirm: 3 }, facts)).toThrow(/confirm/);
  });
});
