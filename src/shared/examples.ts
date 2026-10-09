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
];
