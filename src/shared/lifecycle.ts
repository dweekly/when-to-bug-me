// The answer lifecycle and the firefly's glow, as pure functions so they can be unit-tested apart
// from the page. The page calls these; it does not make these choices itself.
//
//   pick an option -> give a basis or skip -> pushback check -> final answer, guess revealed
//   -> "I'm curious: why?" if surprising and no basis yet -> proposed guidance -> kept -> re-route

import { MAX_PUSHBACKS_PER_SESSION, MIN_BASIS_CHARS, WHY_THRESHOLD } from "./constants";
import type { RouteKind } from "./types";

export type Guess = { option: string; p: number }[];

export function topGuess(guess: Guess): { option: string; p: number } {
  return guess.reduce((best, g) => (g.p > best.p ? g : best), guess[0]);
}

export function hasBasis(basis: string | undefined): boolean {
  return (basis ?? "").trim().length >= MIN_BASIS_CHARS;
}

/** Push back only when the choice contradicts the record and the session's ration is not spent. */
export function shouldPushBack(conflictQuote: string | null, pushbacksUsed: number): boolean {
  return Boolean(conflictQuote) && pushbacksUsed < MAX_PUSHBACKS_PER_SESSION;
}

/** True when the final answer went against a guess Bug Me was confident in. */
export function surprised(finalChoice: string, guess: Guess): boolean {
  const top = topGuess(guess);
  return top.option !== finalChoice && top.p >= WHY_THRESHOLD;
}

/** Ask "I'm curious: why?" only when surprised and no basis was given yet. Never ask twice. */
export function shouldAskWhy(finalChoice: string, guess: Guess, basis: string | undefined): boolean {
  return surprised(finalChoice, guess) && !hasBasis(basis);
}

/**
 * Propose standing guidance from a basis when the answer taught something: it surprised Bug Me, or
 * it went against the agent's recommendation. Agreeing with both teaches little, so it is not sent.
 */
export function shouldProposeGuidance(finalChoice: string, recommended: string, guess: Guess, basis: string | undefined): boolean {
  return hasBasis(basis) && (surprised(finalChoice, guess) || finalChoice !== recommended);
}

/** Things the person did that the glow responds to. */
export type GlowEvent =
  | { kind: "answered"; route: RouteKind; basis: boolean; againstRecommendation: boolean }
  | { kind: "guidance_kept" }
  | { kind: "rule_edited" }
  | { kind: "correction_mark" }
  | { kind: "shouldnt_have_come" };

/**
 * How much each event moves the glow, from 0 (dim) to 1 (bright). Heuristics, chosen so a handful of
 * real reasons lights it up and a single unexplained acceptance only dims it a little. The glow
 * never reacts to absence or idle time.
 */
export const GLOW_STEP = {
  basis: 0.15,
  overrideWithBasis: 0.1,
  guidanceKept: 0.15,
  ruleEdited: 0.1,
  correction: 0.1,
  /** A substantive decision accepted without any recorded basis. */
  noBasisOnDecision: -0.08,
} as const;

/** Where the glow starts: a gentle, neutral light. */
export const GLOW_START = 0.35;

export type Mood = "resting" | "glowing" | "dim" | "sheepish" | "neutral";

export function nextGlow(glow: number, e: GlowEvent): number {
  let g = glow;
  if (e.kind === "answered") {
    if (e.basis) g += GLOW_STEP.basis + (e.againstRecommendation ? GLOW_STEP.overrideWithBasis : 0);
    else if (e.route === "decide") g += GLOW_STEP.noBasisOnDecision;
  } else if (e.kind === "guidance_kept") g += GLOW_STEP.guidanceKept;
  else if (e.kind === "rule_edited") g += GLOW_STEP.ruleEdited;
  else if (e.kind === "correction_mark") g += GLOW_STEP.correction;
  return Math.min(1, Math.max(0, g));
}

/** The firefly's mood after an event, given whether anything is still waiting on the person. */
export function moodAfter(e: GlowEvent | null, glow: number, waiting: number): Mood {
  if (waiting === 0) return "resting";
  if (e?.kind === "shouldnt_have_come") return "sheepish";
  if (e?.kind === "answered" && !e.basis && e.route === "decide") return "dim";
  return glow >= 0.6 ? "glowing" : "neutral";
}

/**
 * The standing fact created when the person keeps proposed guidance. Shared by the page and the
 * recording script so a recorded re-route matches the page's request byte for byte.
 */
export function keptFact(
  existing: { id: string }[],
  proposal: { kind: "add" | "replace" | "none"; replaces: string; scope: string },
  text: string,
  chosenLabel: string,
): { id: string; text: string; source: string; scope: string } {
  const taken = new Set(existing.map((f) => f.id));
  let n = existing.length + 1;
  while (taken.has(`F${n}`)) n++;
  const id = proposal.kind === "replace" && proposal.replaces ? proposal.replaces : `F${n}`;
  return { id, text: text.trim(), source: `your answer this morning on "${chosenLabel}"`, scope: proposal.scope || "all" };
}

/** Replace or append a kept fact. */
export function withFact<T extends { id: string }>(facts: T[], fact: T): T[] {
  return facts.some((f) => f.id === fact.id) ? facts.map((f) => (f.id === fact.id ? fact : f)) : [...facts, fact];
}
