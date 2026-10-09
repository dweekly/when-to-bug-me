/// <reference types="vite/client" />
// Fixture lint: the contract the hand-written fixtures in fixtures/ must keep (build plan, "The
// persona" and the unit acceptance line). Files are read through Vite's import.meta.glob so the test
// needs no Node type definitions.

import { describe, expect, it } from "vitest";
import { decisions, persona } from "./helpers";

/** The 18 task categories from the original brief, restated as engineering decisions. */
const CATEGORIES = [
  "Email and replies",
  "Calendar",
  "Meeting follow-up",
  "Expenses and purchasing",
  "Hiring",
  "Performance and feedback",
  "Customer escalations",
  "Sales and pricing",
  "Marketing and publishing",
  "Reporting",
  "Data cleanup",
  "Contracts and documents",
  "Project planning",
  "Access and IT",
  "Travel",
  "Internal announcements",
  "A badly asked question",
  "Task budget check-in",
];

/** Every fixture file as raw text, keyed by path relative to this test. */
const raw = import.meta.glob("../../fixtures/**/*.{json,html}", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;
const variantFiles = new Set(Object.keys(raw).filter((p) => p.startsWith("../../fixtures/variants/")).map((p) => p.split("/").pop()!));

describe("fixture lint", () => {
  it("found the fixture files (so the checks below can fail)", () => {
    expect(Object.keys(raw)).toEqual(expect.arrayContaining(["../../fixtures/decisions.json", "../../fixtures/persona.json"]));
    expect(decisions.length).toBeGreaterThanOrEqual(CATEGORIES.length);
  });

  it("covers all 18 categories, and every other category starts with 'Code: '", () => {
    expect(CATEGORIES).toHaveLength(18);
    const used = new Set(decisions.map((d) => d.category));
    for (const c of CATEGORIES) expect(used, c).toContain(c);
    for (const c of used) {
      if (!CATEGORIES.includes(c)) expect(c.startsWith("Code: "), c).toBe(true);
    }
  });

  it("has unique ids", () => {
    const ids = decisions.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every option key bounds, and bounds only for option keys", () => {
    for (const d of decisions) {
      const keys = d.options.map((o) => o.key);
      expect(new Set(keys).size, d.id).toBe(keys.length);
      expect(Object.keys(d.bounds).sort(), d.id).toEqual([...keys].sort());
      for (const k of keys) {
        expect(["yes", "partly", "no"], `${d.id}.${k}`).toContain(d.bounds[k].reversible);
        expect(d.bounds[k].cost_usd, `${d.id}.${k}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("recommends one of the options", () => {
    for (const d of decisions) expect(d.options.map((o) => o.key), d.id).toContain(d.recommended);
  });

  it("pairs only with existing decisions, and pairs are mutual", () => {
    const byId = new Map(decisions.map((d) => [d.id, d]));
    const paired = decisions.filter((d) => d.pair);
    expect(paired.length).toBeGreaterThan(0);
    for (const d of paired) {
      const other = byId.get(d.pair!);
      expect(other, `${d.id} -> ${d.pair}`).toBeDefined();
      expect(other!.pair, `${d.pair} should pair back to ${d.id}`).toBe(d.id);
      expect(other!.id).not.toBe(d.id);
    }
  });

  it("puts every decision in a project that persona.json defines", () => {
    const projects = new Set(persona.projects.map((p) => p.id));
    for (const d of decisions) expect(projects, d.id).toContain(d.project);
  });

  it("marks the persona synthetic", () => {
    expect(persona.synthetic).toBe(true);
  });

  it("uses only .example email addresses anywhere in fixtures", () => {
    const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
    const found: string[] = [];
    for (const [path, text] of Object.entries(raw)) {
      for (const m of text.match(email) ?? []) {
        found.push(m);
        expect(m.endsWith(".example"), `${m} in ${path}`).toBe(true);
      }
    }
    // The settings variants show Jordan's address, so the scan must have seen at least one.
    expect(found.length).toBeGreaterThan(0);
  });

  it("points every explored-options variant at a file in fixtures/variants, keyed by an option", () => {
    const explored = decisions.filter((d) => d.explore);
    expect(explored.length).toBeGreaterThan(0);
    for (const d of explored) {
      expect(d.explore!.kind).toBe("variants");
      for (const [key, file] of Object.entries(d.explore!.variants)) {
        expect(d.options.map((o) => o.key), `${d.id} variant ${key}`).toContain(key);
        expect(variantFiles, `${d.id} variant ${key}`).toContain(file);
      }
    }
  });
});
