// Shapes shared by the Worker, the page and the tests. Fixtures in fixtures/ follow these types.

export type RouteKind = "settle" | "check_in" | "decide";
export type Reversible = "yes" | "partly" | "no";
export type Cost = "cheap" | "moderate" | "expensive";
/** The question critic's categories, ported from the bench's CRITIQUE_INSTRUCTIONS. */
export type Problem =
  | "fine"
  | "recommendation_conflicts_with_written_rule"
  | "should_investigate_before_asking"
  | "not_enough_context_to_decide"
  | "unplanned_scope"
  | "options_unusable"
  | "other";

/**
 * Where a card's content came from, shown as a badge on every card: called just now; an earlier live
 * result for the identical request; a labeled recorded example packaged with the Worker; or plain code.
 * "Code adjusted this route" is a separate annotation (Card.adjusted), not a source.
 */
export type Source = "live" | "cached" | "recorded" | "code";

export interface Option {
  key: string;
  label: string;
  description?: string;
}

/** One waiting decision from an agent, as the fixtures hold it. */
export interface Decision {
  id: string;
  category: string;
  project: string;
  /** The chain of agents from the top-level session down to the subagent that asked. */
  agent: string[];
  waiting_minutes: number;
  /** How many agents are blocked on this answer. */
  unblocks: number;
  question: string;
  options: Option[];
  recommended: string;
  context: string;
  /** A designed partner: one answer on this decision should plausibly change the other. */
  pair?: string;
  explore?: { kind: "variants"; variants: Record<string, string> };
  /**
   * Hand-authored, conservative bounds per option key: whether taking that option can be undone, and
   * what it costs. Only these, never the model's say-so, can make an option eligible to settle alone.
   */
  bounds: Record<string, { reversible: Reversible; cost_usd: number; undo_cost?: string }>;
  /** A purpose-built briefing drawn as SVG on the decision's card; every number is in the decision's own text. */
  visual?: Visual;
  /** Topic tags. Kept guidance re-routes waiting decisions that share a tag with its source decision. */
  tags: string[];
  /** Hand-authored kind of housekeeping work, for grouping what Bug Me settled (docs/STAGE-6.md). Display only. */
  work?: "branches" | "updates" | "formatting" | "flaky-tests";
}

/** A decision briefing, drawn by src/page/visuals.ts. Each kind shows what changes under each option. */
export type Visual =
  | { kind: "timeline"; from: string; to: string; marks: { at: string; label: string }[]; bars: { option: string; from: string; to: string; label: string }[] }
  | { kind: "clocks"; zones: { label: string; time: string }[]; repeat: string }
  | { kind: "chart"; unit: string; series: number[]; spike: number; spike_label: string; variants: Record<string, "omit" | "annotate"> }
  | { kind: "payload"; lines: string[]; field: string; variants: Record<string, string>; reach: string }
  | { kind: "bars"; unit: string; items: { option: string; value: number; label: string; note: string }[] };

export interface Rule {
  id: string;
  text: string;
}

export interface Fact {
  id: string;
  text: string;
  source: string;
  scope: string;
}

export interface Project {
  id: string;
  name: string;
  blurb: string;
}

export interface Persona {
  synthetic: true;
  name: string;
  first_name: string;
  pronouns: string;
  role: string;
  company: string;
  company_blurb: string;
  fleet_size: number;
  projects: Project[];
  how_to_work_with_me: string[];
  how_to_work_with_me_source: string;
}

/** What the routing prompt returns, validated by parseRouteOutput. */
export interface RouteOutput {
  route: RouteKind;
  /** When route is "settle", the option Bug Me picks; otherwise "". */
  settle_option: string;
  reversible: Reversible;
  cost: Cost;
  /** The written rule that explicitly lets Bug Me settle this, copied exactly, or "". */
  clearing_rule: string;
  /** The written rule this decision turned on, copied exactly, or "". */
  rule_quoted: string;
  /** The standing fact this decision turned on, copied exactly, or "". */
  fact_quoted: string;
  /** One sentence: why this is settled, a check-in, or a decision. */
  why_here: string;
  /** The question in the person's terms, one short line. */
  headline: string;
  /** A short neutral briefing: what changes under each option, in the person's terms. */
  in_your_terms: string;
  /** Two plain sentences on what is going on, shown before the question. */
  briefing: string;
  /** Per option, exactly one entry each: up to two pros, up to two cons, and a one-line consequence or "". */
  option_notes: OptionNote[];
  problem: Problem;
  /** A probability per option key, summing to about 1. */
  guess: { option: string; p: number }[];
  /** Options that contradict a standing fact or rule, with the text they contradict. */
  conflicts: { option: string; quoted: string }[];
  /** What each option tells the asking agent, in its own terms. */
  send_down: { option: string; instruction: string }[];
}

/** What the card shows under an option: its pros and cons, and what it costs, in the person's terms. */
export interface OptionNote {
  option: string;
  pros: string[];
  cons: string[];
  /** Money, time or work for the agents, from facts in the decision; "" when there is none to state. */
  consequence: string;
}

/** The hidden part of a routed card: sealed by the Worker, opened only after the answer. */
export interface Sealed {
  id: string;
  guess: RouteOutput["guess"];
  conflicts: RouteOutput["conflicts"];
  send_down: RouteOutput["send_down"];
}

/** A routed card as the page receives it. The guess is inside `sealed`, never in the clear. */
export interface Card {
  id: string;
  route: RouteKind;
  /** The model's own route before the code invariant. */
  model_route: RouteKind;
  /** When route is "settle", the option Bug Me picked. */
  settle_option: string;
  /** Set when code changed the model's route; says which condition was missing. */
  adjusted?: string;
  reversible: Reversible;
  cost: Cost;
  clearing_rule: string;
  rule_quoted: string;
  fact_quoted: string;
  why_here: string;
  headline: string;
  in_your_terms: string;
  /** Absent on cards saved before these fields existed; the page renders without them. */
  briefing?: string;
  option_notes?: OptionNote[];
  problem: Problem;
  source: Source;
  sealed: string;
  /** From the fast model, display only; absent when it couldn't be evaluated (docs/STAGE-6.md, 1b). */
  emoji?: string;
  title?: string;
  /** Per option key, what was done if it was taken, in the past tense. */
  done?: Record<string, string>;
}

/** What /api/ask returns: an answer from what the agent provided, or what is missing from it. */
export interface AskOutput {
  answerable: boolean;
  answer: string;
}

/** One phrase Bug Me picked out of what the person said, copied exactly from their words. */
export interface Mark {
  kind: "choice" | "why" | "but" | "ask";
  quote: string;
}

/** What /api/parse returns for the person's thinking out loud: their choice, if any, and the marks. */
export interface ParseOutput {
  /** An option key, "other" for a different course (its words are the choice marks), or "none". */
  choice: string;
  marks: Mark[];
}

/**
 * What /api/fact returns: new guidance, a replacement for a named existing fact, or nothing durable
 * ("just this once", a misclick). Nothing is applied until the person keeps it.
 */
export interface FactOutput {
  kind: "add" | "replace" | "none";
  /** For "replace": the id of the existing fact it replaces; otherwise "". */
  replaces: string;
  text: string;
  scope: string;
  /** One line confirming back what was understood. */
  confirm: string;
  /** Waiting decision ids this guidance may change; validated against known ids by code. */
  may_affect: string[];
}
