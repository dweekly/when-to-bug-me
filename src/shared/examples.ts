// The canonical examples: scripted answers, with their reasons, that are recorded against live
// Claude so a visitor can run the whole loop even when live calls are off. The page offers each
// reason as an explicitly labeled recorded example; it never substitutes one for the visitor's words.

export interface Example {
  id: string;
  choice: string;
  reason: string;
}

export const EXAMPLES: Example[] = [
  {
    id: "onsite-flight",
    choice: "B",
    reason: "Mornings before 8:30 are school drop-off. I don't take 6am flights, even to save money.",
  },
  {
    id: "api-rename",
    choice: "B",
    reason: "Renaming a field breaks every integrator who already parses v1 responses. In anything public, keep existing names; tidiness isn't worth breaking customers.",
  },
  {
    id: "settings-redesign",
    choice: "B",
    reason: "Everything is on one page, so people scroll straight to API keys and still see what else is there; tabs would hide the other settings behind clicks.",
  },
  {
    id: "reconciliation-path",
    choice: "B",
    reason: "Corrected invoices for a few cents would confuse customers and give finance a mess to explain. Fix the tax going forward; don't rewrite invoices people already paid.",
  },
];
