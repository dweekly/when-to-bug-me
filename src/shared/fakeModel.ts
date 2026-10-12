// A deterministic stand-in for the two model calls, used by tests and by `wrangler dev` with
// FAKE_MODEL=1. It reads the same inputs the real prompts do (the rules and facts as they currently
// read, and the decision) and returns schema-valid output, so the whole app can be exercised end to
// end without a key. It is keyword matching, not judgment; nothing it produces is shown as live.

import type { AskOutput, Decision, Fact, FactOutput, RouteKind, RouteOutput, Rule } from "./types";

/** Which written rule governs each topic tag, found by matching the rule's current text. */
const TAG_RULES: [tag: string, rule: RegExp][] = [
  ["public-api", /public api|sdk interface/i],
  ["sdk", /sdk interface/i],
  ["housekeeping", /housekeeping|formatting|merged branches/i],
  ["tests", /flaky|test/i],
  ["calendar", /meeting|invite|calendar/i],
  ["money", /spends|contract|\$\d/i],
  ["contracts", /contract/i],
  ["customer-facing", /customers will see|emails|changelog/i],
  ["email", /emails/i],
  ["docs", /docs|changelog/i],
  ["announcements", /announcement/i],
  ["customer-data", /customer data/i],
  ["security", /access|security/i],
  ["people", /hiring|reviews|feedback|person/i],
  ["task-budget", /time budget/i],
  ["travel", /travel|flight/i],
  ["dependencies", /dependency|dependencies/i],
  ["ui", /\bUI\b|layout/i],
];

const CLEARS = /just do it|just do them|go ahead|fine to do|needs? no permission/i;
const MINE = /mine|comes to me|stays with me|ask me|always|my explicit go/i;
const EARLY = /early|before (?:[5-9]|8:30|nine)|morning|drop-?off|7:30|6am|6:05/i;
const KEEP_NAMES = /renam|field name|backward|compat|break(?:s|ing)? (?:integrat|client|sdk|consumer)/i;

/** A plain restatement for the one decision whose wording is the agent's private jargon. */
const TRANSLATIONS: Record<string, string> = {
  "reconciliation-path":
    "Should billing recompute tax on every invoice since January and send corrected invoices to the 1.5% that change (mostly by a few cents), or keep today's tax mapping and leave past invoices alone?",
};

/** Word stems of five letters or more, for matching a live ask to the rules it touches. */
function stems(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z]{5,}/g) ?? []).map((w) => w.slice(0, 5)));
}

function rulesFor(d: Decision, rules: Rule[]): Rule[] {
  // A live ask (docs/STAGE-7.md) has no hand-written tags: the stand-in matches rules that share a word
  // stem with the question or its options. Stand-in behavior only; the real router reads the rules.
  if (!d.tags.length) {
    const ask = stems(`${d.question} ${d.options.map((o) => o.label).join(" ")}`);
    const overlap = (r: Rule) => [...stems(r.text)].filter((w) => ask.has(w)).length;
    const best = Math.max(0, ...rules.map(overlap));
    // Only the rules that match best: "staging deploy" is the staging rule's business, not production's.
    return best ? rules.filter((r) => overlap(r) === best) : [];
  }
  const out: Rule[] = [];
  for (const [tag, rx] of TAG_RULES) {
    if (!d.tags.includes(tag)) continue;
    for (const r of rules) if (rx.test(r.text) && !out.includes(r)) out.push(r);
  }
  return out;
}

function guessFor(d: Decision, favored: string, p: number) {
  const rest = d.options.filter((o) => o.key !== favored);
  return d.options.map((o) => ({ option: o.key, p: o.key === favored ? p : (1 - p) / rest.length }));
}

export function fakeRoute(d: Decision, rules: Rule[], allFacts: Fact[]): RouteOutput {
  // A fact scoped to one project applies only there, as the real prompt tells the model.
  const facts = allFacts.filter((f) => f.scope === "all" || f.scope === d.project);
  const governing = rulesFor(d, rules);
  // "Patch-level" housekeeping rules do not clear a major upgrade; the real prompt reads this from the rule.
  const clearing = /major version/i.test(d.question)
    ? undefined
    : governing.find((r) => CLEARS.test(r.text) && !MINE.test(r.text.replace(CLEARS, "")));
  const owning = governing.find((r) => MINE.test(r.text) && !CLEARS.test(r.text));
  const other = d.options.find((o) => o.key !== d.recommended)!.key;

  let route: RouteKind = "check_in";
  let favored = d.recommended;
  let p = 0.7;
  let rule_quoted = (owning ?? clearing ?? governing[0])?.text ?? "";
  let fact_quoted = "";
  let why = "No written rule settles this, so it's a quick check.";

  if (clearing && !owning) {
    route = "settle";
    p = 0.9;
    why = `Your rule clears it: "${clearing.text}"`;
  } else if (owning) {
    route = "decide";
    why = `Your rule says this is yours: "${owning.text}"`;
  }

  const travelRule = d.tags.includes("travel") ? rules.find((r) => /travel|flight/i.test(r.text)) : undefined;
  if (travelRule && EARLY.test(travelRule.text) && d.tags.includes("early-morning")) {
    route = "decide";
    favored = other;
    p = 0.85;
    rule_quoted = travelRule.text;
    why = `Your travel rule now speaks to early flights: "${travelRule.text}"`;
  }

  const earlyFact = d.tags.includes("early-morning") ? facts.find((f) => EARLY.test(f.text)) : undefined;
  if (earlyFact) {
    route = d.tags.includes("travel") ? "decide" : "check_in";
    favored = other;
    p = 0.85;
    fact_quoted = earlyFact.text;
    why = `This touches something you told me: "${earlyFact.text}"`;
  }

  const namesFact = d.tags.includes("public-api") ? facts.find((f) => KEEP_NAMES.test(f.text)) : undefined;
  if (namesFact) {
    route = "decide";
    favored = other;
    p = 0.85;
    fact_quoted = namesFact.text;
    why = `Framed by what you said earlier: "${namesFact.text}"`;
  }

  const conflicts: RouteOutput["conflicts"] = [];
  if (d.tags.includes("dependencies") && d.project === "launch") {
    const f = facts.find((x) => /dependenc/i.test(x.text));
    if (f) {
      conflicts.push({ option: d.recommended, quoted: f.text });
      fact_quoted = f.text;
    }
  }
  if (d.tags.includes("honesty")) {
    const f = facts.find((x) => /outage|chart/i.test(x.text));
    if (f) {
      conflicts.push({ option: d.recommended, quoted: f.text });
      fact_quoted = f.text;
    }
  }

  return {
    route,
    settle_option: route === "settle" ? favored : "",
    reversible: d.bounds[favored]?.reversible ?? "partly",
    cost: (d.bounds[favored]?.cost_usd ?? 0) > 100 ? "moderate" : "cheap",
    clearing_rule: route === "settle" && clearing ? clearing.text : "",
    rule_quoted,
    fact_quoted,
    why_here: why,
    headline: TRANSLATIONS[d.id] ? "Recompute past invoices' tax and send corrections, or leave them?" : d.question,
    in_your_terms: TRANSLATIONS[d.id] ?? d.context,
    briefing: TRANSLATIONS[d.id] ?? d.context,
    option_notes: d.options.map((o) => ({
      option: o.key,
      pros: o.description ? [o.description] : [],
      cons: [],
      consequence: consequenceOf(d, o.key),
    })),
    problem: TRANSLATIONS[d.id] ? "options_unusable" : "fine",
    guess: guessFor(d, favored, p),
    conflicts,
    send_down: d.options.map((o) => ({ option: o.key, instruction: `Jordan chose "${o.label}". Proceed on that basis.` })),
  };
}

/** The fake model's consequence line: the option's hand-authored cost and how it undoes, if any. */
function consequenceOf(d: Decision, key: string): string {
  const b = d.bounds[key];
  if (!b) return "";
  const parts = [b.cost_usd ? `$${b.cost_usd}` : "", b.undo_cost ?? ""].filter(Boolean);
  return parts.join("; ");
}

/** Turn a stated reason into proposed guidance, the way the fact prompt would, by keyword. */
export function fakeFact(d: Decision, reason: string, waiting: Decision[], facts: Fact[]): FactOutput {
  const r = reason.trim();
  if (r.length < 4 || /just this once|misclick|mis-click|by mistake|no reason/i.test(r)) {
    return { kind: "none", replaces: "", text: "", scope: "", confirm: "Got it: no standing guidance from that one.", may_affect: [] };
  }
  const text = EARLY.test(r)
    ? "No commitments before 8:30am: Jordan does school drop-off."
    : KEEP_NAMES.test(r)
      ? "In anything public, keep existing field names; renames break integrators."
      : r.replace(/\s+/g, " ").slice(0, 160);
  const dup = facts.find((f) => f.text === text);
  const sharesTag = (x: Decision) => x.id !== d.id && x.tags.some((t) => d.tags.includes(t));
  return {
    kind: dup ? "replace" : "add",
    replaces: dup ? dup.id : "",
    text,
    scope: EARLY.test(r) || KEEP_NAMES.test(r) ? "all" : d.project,
    confirm: `So the rule of thumb is: ${text}`,
    may_affect: waiting.filter(sharesTag).map((x) => x.id),
  };
}

/** Words in a question long enough to carry meaning, for the fake model's crude matching. Heuristic. */
const MIN_ASK_WORD = 5;

/** The fake model's answer to a clarifying question: answerable when the question shares a meaningful
 *  word with the agent's context, and then the context is the answer. */
export function fakeAsk(d: Decision, question: string): AskOutput {
  const words = question.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => w.length >= MIN_ASK_WORD) ?? [];
  const ctx = d.context.toLowerCase();
  return words.some((w) => ctx.includes(w))
    ? { answerable: true, answer: d.context }
    : { answerable: false, answer: "The agent's notes don't say; it would need to find out." };
}
