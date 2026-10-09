// Validating the clarifying-question prompt's answer beyond its JSON shape.

import type { AskOutput } from "./types";

export class AskParseError extends Error {}

/** Longest answer accepted, in characters: two or three sentences. Longer means it rambled. */
const MAX_ANSWER_CHARS = 600;

export function parseAskOutput(raw: unknown): AskOutput {
  if (!raw || typeof raw !== "object") throw new AskParseError("not an object");
  const o = raw as Record<string, unknown>;
  if (typeof o.answerable !== "boolean") throw new AskParseError("answerable is not a boolean");
  if (typeof o.answer !== "string") throw new AskParseError("answer is not a string");
  const answer = o.answer.trim();
  if (!answer || answer.length > MAX_ANSWER_CHARS) throw new AskParseError("answer is empty or too long");
  return { answerable: o.answerable, answer };
}
