// The canonical examples: scripted answers, with their reasons, that are recorded against live
// Claude so a visitor can run the whole loop even when live calls are off. The page offers each
// reason as an explicitly labeled recorded example; it never substitutes one for the visitor's words.
//
// Each tour decision also has a scripted conversation (docs/STAGE-6.md): Jordan's turns, in order, and
// what Bug Me is expected to do after each one, once `advance` has had its say. The recorder plays it
// against live Claude and fails when Bug Me does something else; the tours offer the same turns.

import type { Next } from "./converse";

/** One scripted conversation: Jordan's turns, and Bug Me's expected `next` after each. Ends at a
 *  read-back, which Jordan confirms with the button (no further call). */
export interface Script {
  id: string;
  turns: { text: string; pick?: string }[];
  expect: Next[];
  /** The listed option the thread resolves to. */
  choice: string;
}

export interface Example {
  id: string;
  choice: string;
  /** What Jordan says thinking it through, offered in the think-out-loud box. */
  narration: string;
  /** The reason alone, offered in the "I'm curious: why?" box. */
  reason: string;
}

export const EXAMPLES: Example[] = [
  {
    id: "onsite-flight",
    choice: "B",
    narration: "Let's take the 9:40.",
    reason: "Mornings before 8:30 are school drop-off. I don't take 6am flights, even to save money.",
  },
  {
    id: "api-rename",
    choice: "B",
    narration:
      "Hmm. I'd keep user_id. Renaming a field breaks every integrator who already parses v1 responses. In anything public, keep existing names; tidiness isn't worth breaking customers. But note account_id in the docs as the internal name. How many integrations read that field directly?",
    reason: "Renaming a field breaks every integrator who already parses v1 responses. In anything public, keep existing names; tidiness isn't worth breaking customers.",
  },
  {
    id: "settings-redesign",
    choice: "B",
    narration: "One page. Everything is on one page, so people scroll straight to API keys and still see what else is there; tabs would hide the other settings behind clicks.",
    reason: "Everything is on one page, so people scroll straight to API keys and still see what else is there; tabs would hide the other settings behind clicks.",
  },
  {
    id: "reconciliation-path",
    choice: "B",
    narration: "Keep the T-19 mapping. Corrected invoices for a few cents would confuse customers and give finance a mess to explain. Fix the tax going forward; don't rewrite invoices people already paid.",
    reason: "Corrected invoices for a few cents would confuse customers and give finance a mess to explain. Fix the tax going forward; don't rewrite invoices people already paid.",
  },
];

const said = (id: string) => EXAMPLES.find((e) => e.id === id)!;

/** Jordan's side of each tour decision's conversation. */
export const CONVERSATIONS: Script[] = [
  // A bare pick earns one light "why?"; the answer becomes the reason.
  { id: "onsite-flight", turns: [{ text: said("onsite-flight").narration }, { text: said("onsite-flight").reason }], expect: ["ask", "confirm"], choice: "B" },
  // Choice, reasons, a condition and a question the agent's material can't answer, all in one turn.
  { id: "api-rename", turns: [{ text: said("api-rename").narration }], expect: ["confirm"], choice: "B" },
  { id: "settings-redesign", turns: [{ text: said("settings-redesign").narration }], expect: ["confirm"], choice: "B" },
  { id: "reconciliation-path", turns: [{ text: said("reconciliation-path").narration }], expect: ["confirm"], choice: "B" },
  // The pushback tour: a click on the agent's pick with no words, then "just do it". Bug Me stops
  // asking; the answer then meets Jordan's own record (no new SDK dependencies) before it goes out.
  { id: "sdk-dependency", turns: [{ text: "", pick: "A" }, { text: "Just do it." }], expect: ["ask", "confirm"], choice: "A" },
];
