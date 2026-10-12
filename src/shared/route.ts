// Turning a model's routing answer into a card's public fields: validate the shape and meaning, check
// every quote against the current rules and facts, and enforce the settle invariant in code.

import { MAX_OPTION_NOTES, SETTLE_MAX_COST_USD } from "./constants";
import type {
  Decision,
  Fact,
  Problem,
  RouteKind,
  RouteOutput,
  Rule,
} from "./types";

const ROUTES: RouteKind[] = ["settle", "check_in", "decide"];
const REVERSIBLE = ["yes", "partly", "no"] as const;
const COSTS = ["cheap", "moderate", "expensive"] as const;
export const PROBLEMS: Problem[] = [
  "fine",
  "recommendation_conflicts_with_written_rule",
  "should_investigate_before_asking",
  "not_enough_context_to_decide",
  "unplanned_scope",
  "options_unusable",
  "other",
];

/** Tolerance on the guess probabilities summing to 1, as in the bench's parse_probs (0.98 to 1.02). */
const SUM_TOLERANCE = 0.02;

export class RouteParseError extends Error {}

function str(v: unknown, field: string): string {
  if (typeof v !== "string")
    throw new RouteParseError(`${field} is not a string`);
  return v;
}

function oneOf<T extends string>(
  v: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    throw new RouteParseError(`${field} is not one of ${allowed.join(", ")}`);
  }
  return v as T;
}

/**
 * Validate the routing JSON against the decision it was asked about: the schema guarantees shape, but
 * not that the option keys exist, that every option has a probability, or that they sum to one.
 * Probabilities are renormalized after the check.
 */
export function parseRouteOutput(
  raw: unknown,
  decision: Decision,
): RouteOutput {
  if (!raw || typeof raw !== "object")
    throw new RouteParseError("not an object");
  const o = raw as Record<string, unknown>;
  const keys = decision.options.map((x) => x.key);

  const guessRaw = o.guess;
  if (!Array.isArray(guessRaw))
    throw new RouteParseError("guess is not an array");
  const seen = new Set<string>();
  const guess = guessRaw.map((g, i) => {
    const option = oneOf(g?.option, keys, `guess[${i}].option`);
    const p = g?.p;
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
      throw new RouteParseError(`guess[${i}].p is not a probability`);
    }
    if (seen.has(option))
      throw new RouteParseError(`guess repeats option ${option}`);
    seen.add(option);
    return { option, p };
  });
  if (seen.size !== keys.length)
    throw new RouteParseError("guess does not cover every option");
  const total = guess.reduce((s, g) => s + g.p, 0);
  if (total < 1 - SUM_TOLERANCE || total > 1 + SUM_TOLERANCE)
    throw new RouteParseError(`guess sums to ${total.toFixed(3)}`);
  for (const g of guess) g.p = g.p / total;

  const conflictsRaw = Array.isArray(o.conflicts) ? o.conflicts : [];
  const conflicts = conflictsRaw.map((c, i) => ({
    option: oneOf(c?.option, keys, `conflicts[${i}].option`),
    quoted: str(c?.quoted, `conflicts[${i}].quoted`),
  }));

  const sendRaw = o.send_down;
  if (!Array.isArray(sendRaw))
    throw new RouteParseError("send_down is not an array");
  const send_down = sendRaw.map((s, i) => ({
    option: oneOf(s?.option, keys, `send_down[${i}].option`),
    instruction: str(s?.instruction, `send_down[${i}].instruction`),
  }));
  const sent = new Set(send_down.map((s) => s.option));
  if (sent.size !== send_down.length)
    throw new RouteParseError("send_down repeats an option");
  if (sent.size !== keys.length)
    throw new RouteParseError("send_down does not cover every option");

  // The schema asks for an object keyed by option; an array of { option, ... } is accepted too.
  const notesObj = o.option_notes;
  const notesRaw = Array.isArray(notesObj)
    ? notesObj
    : notesObj && typeof notesObj === "object"
      ? Object.entries(notesObj as Record<string, Record<string, unknown>>).map(
          ([option, n]) => ({ ...n, option }),
        )
      : null;
  if (!notesRaw) throw new RouteParseError("option_notes is not an object");
  const phrases = (v: unknown, field: string) => {
    if (!Array.isArray(v))
      throw new RouteParseError(`${field} is not an array`);
    if (v.length > MAX_OPTION_NOTES)
      throw new RouteParseError(
        `${field} has more than ${MAX_OPTION_NOTES} entries`,
      );
    return v.map((x, i) => {
      const t = str(x, `${field}[${i}]`).trim();
      if (!t) throw new RouteParseError(`${field}[${i}] is empty`);
      return t;
    });
  };
  const option_notes = notesRaw.map((n, i) => ({
    option: oneOf(n?.option, keys, `option_notes[${i}].option`),
    pros: phrases(n?.pros, `option_notes[${i}].pros`),
    cons: phrases(n?.cons, `option_notes[${i}].cons`),
    consequence: str(
      n?.consequence ?? "",
      `option_notes[${i}].consequence`,
    ).trim(),
  }));
  const noted = new Set(option_notes.map((n) => n.option));
  if (noted.size !== option_notes.length)
    throw new RouteParseError("option_notes repeats an option");
  if (noted.size !== keys.length)
    throw new RouteParseError("option_notes does not cover every option");

  const route = oneOf(o.route, ROUTES, "route");
  const settle_option = str(o.settle_option ?? "", "settle_option");
  if (route === "settle" && !keys.includes(settle_option)) {
    throw new RouteParseError(
      "route is settle but settle_option is not an option",
    );
  }

  return {
    route,
    settle_option: route === "settle" ? settle_option : "",
    reversible: oneOf(o.reversible, REVERSIBLE, "reversible"),
    cost: oneOf(o.cost, COSTS, "cost"),
    clearing_rule: str(o.clearing_rule, "clearing_rule"),
    rule_quoted: str(o.rule_quoted, "rule_quoted"),
    fact_quoted: str(o.fact_quoted, "fact_quoted"),
    why_here: str(o.why_here, "why_here"),
    headline: str(o.headline, "headline"),
    in_your_terms: str(o.in_your_terms, "in_your_terms"),
    briefing: str(o.briefing, "briefing"),
    option_notes: option_notes.sort(
      (a, b) => keys.indexOf(a.option) - keys.indexOf(b.option),
    ),
    problem: oneOf(o.problem, PROBLEMS, "problem"),
    guess,
    conflicts,
    send_down,
  };
}

/** Collapse whitespace, curly quotes and case so a faithful copy of a rule matches its source. */
export function normalizeQuote(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, "")
    .toLowerCase();
}

/**
 * Return the source text a quote faithfully copies (a whole rule or fact, or a contiguous part of one
 * at least `minLen` characters long), or "" when it occurs nowhere. A quote that does not occur is
 * dropped rather than shown, so the page never attributes invented words to the person.
 */
export function verifyQuote(
  quote: string,
  sources: string[],
  minLen = 12,
): string {
  const q = normalizeQuote(quote);
  if (!q) return "";
  const whole = wholeSource(quote, sources);
  if (whole) return whole;
  if (q.length < minLen) return "";
  for (const s of sources) {
    if (normalizeQuote(s).includes(q)) return s;
  }
  return "";
}

/** The source text a quote copies in full (up to whitespace, curly quotes, case and a final period), or "". */
export function wholeSource(quote: string, sources: string[]): string {
  const q = normalizeQuote(quote);
  if (!q) return "";
  return sources.find((s) => normalizeQuote(s) === q) ?? "";
}

/**
 * Stricter limits for a world whose bounds aren't hand-authored (docs/STAGE-7.md: the live queue, where
 * the asking agent declares them): a lower cost ceiling, and only rules that grant permission may clear.
 */
export interface SettleLimits {
  maxCostUsd: number;
  clears: (ruleText: string) => boolean;
  /** A rule that keeps a kind of decision for the person; when the decision turns on one, nothing settles. */
  reserves: (ruleText: string) => boolean;
}

export interface InvariantResult {
  route: RouteKind;
  settle_option: string;
  /** Present when code changed the model's route. */
  adjusted?: string;
}

/**
 * Bug Me settles alone only what is reversible, cheap, and cleared by a written rule. The model's
 * route counts for nothing on its own: the option it picked must be within the decision's
 * hand-authored bounds, and its clearing rule must be the text of a current rule. Anything missing
 * downgrades the route to a check-in, with the reason. This checks exactly these conditions; it does
 * not prove that a natural-language rule really authorizes the action.
 */
export function enforceSettleInvariant(
  out: RouteOutput,
  decision: Decision,
  rules: Rule[],
  facts: Fact[] = [],
  limits?: SettleLimits,
): InvariantResult {
  if (out.route !== "settle") return { route: out.route, settle_option: "" };
  const missing: string[] = [];
  const bound = decision.bounds[out.settle_option];
  if (!bound) missing.push("the option it picked has no bounds");
  else {
    if (bound.reversible !== "yes")
      missing.push("the action can't be fully undone");
    if (bound.cost_usd > (limits?.maxCostUsd ?? SETTLE_MAX_COST_USD))
      missing.push(`it costs $${bound.cost_usd}`);
  }
  // Settling needs a whole current rule, not a fragment of one: "formatting, lint fixes" is not the
  // authorization "...: just do it."
  const clearing = wholeSource(
    out.clearing_rule,
    rules.map((r) => r.text),
  );
  if (!clearing) {
    missing.push("no written rule clears it");
  } else if (limits && !limits.clears(clearing)) {
    missing.push("that rule doesn't let Bug Me act alone");
  }
  // A rule that keeps this kind of decision for the person outranks a general permission.
  // Checked against the same quote verification the card displays, so a partial quote of a reserving rule counts.
  const governing = limits ? verifyQuote(out.rule_quoted, rules.map((r) => r.text)) : "";
  if (limits && governing && limits.reserves(governing)) missing.push("one of your rules keeps this for you");
  // Precedence: a standing preference that bears on the choice outranks a rule that would let Bug Me
  // settle it, so a verified quoted fact always brings it to the person (at least as a check-in).
  if (
    verifyQuote(
      out.fact_quoted,
      facts.map((f) => f.text),
    )
  ) {
    missing.push("one of your standing preferences bears on it");
  }
  if (missing.length === 0)
    return { route: "settle", settle_option: out.settle_option };
  return {
    route: "check_in",
    settle_option: "",
    adjusted: `Claude would have settled this, but code brought it to you: ${missing.join("; ")}.`,
  };
}

/** The public, verified quote fields of a card. */
export function verifiedQuotes(out: RouteOutput, rules: Rule[], facts: Fact[]) {
  const ruleTexts = rules.map((r) => r.text);
  const factTexts = facts.map((f) => f.text);
  return {
    clearing_rule: wholeSource(out.clearing_rule, ruleTexts),
    rule_quoted: verifyQuote(out.rule_quoted, ruleTexts),
    fact_quoted: verifyQuote(out.fact_quoted, factTexts),
  };
}

/**
 * Pushback quotes the person's own record, so a conflict whose quote occurs in no current rule or
 * fact is dropped, and a faithful one carries the exact source text.
 */
export function verifiedConflicts(
  out: RouteOutput,
  rules: Rule[],
  facts: Fact[],
): RouteOutput["conflicts"] {
  const record = [...rules.map((r) => r.text), ...facts.map((f) => f.text)];
  return out.conflicts
    .map((c) => ({ option: c.option, quoted: verifyQuote(c.quoted, record) }))
    .filter((c) => c.quoted);
}
