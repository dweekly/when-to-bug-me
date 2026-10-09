// Validating the fact prompt's answer beyond its JSON shape.

import type { Fact, FactOutput } from "./types";

export class FactParseError extends Error {}

/** Longest standing fact accepted, in characters. A fact is one sentence; longer means it rambled. */
const MAX_FACT_CHARS = 240;

export function parseFactOutput(raw: unknown, facts: Fact[]): FactOutput {
  if (!raw || typeof raw !== "object") throw new FactParseError("not an object");
  const o = raw as Record<string, unknown>;
  const kind = o.kind;
  if (kind !== "add" && kind !== "replace" && kind !== "none") throw new FactParseError("kind is not add, replace or none");
  const s = (v: unknown, f: string) => {
    if (typeof v !== "string") throw new FactParseError(`${f} is not a string`);
    return v.trim();
  };
  const text = s(o.text, "text");
  const replaces = s(o.replaces, "replaces");
  if (kind !== "none" && (text.length === 0 || text.length > MAX_FACT_CHARS)) throw new FactParseError("text is empty or too long");
  if (kind === "replace" && !facts.some((f) => f.id === replaces)) throw new FactParseError("replaces names no existing fact");
  const may = Array.isArray(o.may_affect) ? o.may_affect.filter((x): x is string => typeof x === "string") : [];
  return {
    kind,
    replaces: kind === "replace" ? replaces : "",
    text: kind === "none" ? "" : text,
    scope: s(o.scope, "scope") || "all",
    confirm: s(o.confirm, "confirm"),
    may_affect: may,
  };
}
