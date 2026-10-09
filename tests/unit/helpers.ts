// Fixture loaders shared by the unit tests. The fixtures are the same JSON files the Worker bundles.

import decisionsJson from "../../fixtures/decisions.json";
import factsJson from "../../fixtures/facts.json";
import personaJson from "../../fixtures/persona.json";
import rulesJson from "../../fixtures/rules.json";
import type { Decision, Fact, Persona, RouteOutput, Rule } from "../../src/shared/types";

export const decisions = decisionsJson as Decision[];
export const rules = rulesJson as Rule[];
export const facts = factsJson as Fact[];
export const persona = personaJson as unknown as Persona;

/** A fresh deep copy of one fixture decision, so a test can modify it without touching others. */
export function decision(id: string): Decision {
  const d = decisions.find((x) => x.id === id);
  if (!d) throw new Error(`no fixture decision ${id}`);
  return structuredClone(d);
}

export function rule(id: string): Rule {
  const r = rules.find((x) => x.id === id);
  if (!r) throw new Error(`no fixture rule ${id}`);
  return r;
}

/** A schema-valid routing answer for `d`, favouring its recommended option; override any field. */
export function routeOutput(d: Decision, over: Partial<RouteOutput> = {}): RouteOutput {
  const others = d.options.filter((o) => o.key !== d.recommended);
  return {
    route: "check_in",
    settle_option: "",
    reversible: "yes",
    cost: "cheap",
    clearing_rule: "",
    rule_quoted: "",
    fact_quoted: "",
    why_here: "Because.",
    headline: d.question,
    in_your_terms: d.question,
    briefing: d.context,
    option_notes: d.options.map((o) => ({ option: o.key, pros: ["A plus."], cons: ["A minus."], consequence: "" })),
    problem: "fine",
    guess: d.options.map((o) => ({ option: o.key, p: o.key === d.recommended ? 0.7 : 0.3 / others.length })),
    conflicts: [],
    send_down: d.options.map((o) => ({ option: o.key, instruction: `Do ${o.label}.` })),
    ...over,
  };
}
