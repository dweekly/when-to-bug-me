// The fixtures, imported by the Worker only. They are bundled into the Worker script, never served
// as static assets, so recorded guesses cannot be read by the page before an answer.

import decisionsJson from "../../fixtures/decisions.json";
import factsJson from "../../fixtures/facts.json";
import personaJson from "../../fixtures/persona.json";
import rulesJson from "../../fixtures/rules.json";
import catalogJson from "../../fixtures/catalog.json";
import { type Catalog, parseCatalog } from "../shared/dispatch";
import type { Decision, Fact, Persona, Rule } from "../shared/types";

export const persona = personaJson as Persona;
export const decisions = decisionsJson as Decision[];
export const defaultRules = rulesJson as Rule[];
export const defaultFacts = factsJson as Fact[];
export const byId = new Map(decisions.map((d) => [d.id, d]));

/** The public view of a decision: everything the page shows, nothing hidden. */
export function publicDecision(d: Decision) {
  return {
    id: d.id,
    category: d.category,
    project: d.project,
    agent: d.agent,
    waiting_minutes: d.waiting_minutes,
    unblocks: d.unblocks,
    question: d.question,
    options: d.options,
    recommended: d.recommended,
    ...(d.no_recommendation ? { no_recommendation: true as const } : {}),
    context: d.context,
    explore: d.explore,
    visual: d.visual,
    bounds: d.bounds,
    tags: d.tags,
    work: d.work,
  };
}

/** Jordan's synthetic tools and skills, for the public Dispatch demo (docs/STAGE-8.md). */
export const publicCatalog: Catalog = parseCatalog(catalogJson);
