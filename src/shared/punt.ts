// "Skip": the person sets a decision aside, and says what they would need to decide it. The
// reason is required; each kind of reason asks a pointed question so the agent can act on it. The
// instruction to the agent is a template (no model call), and it is simulated: nothing is gathered.

export type PuntKind = "info" | "input" | "later" | "unsure";

export interface PuntKindSpec {
  kind: PuntKind;
  /** The quick choice, in the person's words. */
  label: string;
  /** The follow-up question that makes the reason actionable. */
  ask: string;
}

export const PUNT_KINDS: PuntKindSpec[] = [
  { kind: "info", label: "I need more information", ask: "What information is missing?" },
  { kind: "input", label: "I need someone else's input", ask: "Whose input, and on what?" },
  { kind: "later", label: "Not urgent yet", ask: "When should it come back, and why then?" },
  { kind: "unsure", label: "I'm not sure what I think", ask: "What's making it hard to call?" },
];

/** A set-aside decision, as kept in the person's record. */
export interface Punt {
  id: string;
  kind: PuntKind;
  /** The person's sentence. Required. */
  reason: string;
  at: string;
  /** Exactly what the asking agent was told (simulated). */
  instruction: string;
}

/** Shortest reason accepted for setting a decision aside: one real clause, not a shrug. Heuristic. */
export const MIN_PUNT_CHARS = 8;

export function puntProblem(kind: PuntKind | null, reason: string): string {
  if (!kind) return "Pick what you need first.";
  if (reason.trim().length < MIN_PUNT_CHARS) return PUNT_KINDS.find((k) => k.kind === kind)!.ask;
  return "";
}

/** What the asking agent is told, in its own terms. */
export function puntInstruction(kind: PuntKind, reason: string, personFirstName: string): string {
  const r = reason.trim().replace(/\s+/g, " ");
  switch (kind) {
    case "info":
      return `${personFirstName} isn't ready to decide. Gather this first, then bring the question back with it: ${r}`;
    case "input":
      return `${personFirstName} wants someone else's input before deciding. Ask for it, then bring the question back with the answer: ${r}`;
    case "later":
      return `${personFirstName} is setting this aside for now. Keep working around it and bring it back then: ${r}`;
    case "unsure":
      return `${personFirstName} isn't sure yet. Prepare what would make the call easier, then bring it back: ${r}`;
  }
}
