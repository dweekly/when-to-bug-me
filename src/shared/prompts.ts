// The two prompts and their output schemas. Ported from the private bench's question critic
// (CRITIQUE_INSTRUCTIONS: judge whether a question should reach the person as asked, quoting a written
// rule exactly) and its person-model prompt (calibrated probability per option), with the person's
// name made a parameter and the three routes added. Bump PROMPT_VERSION on any wording change: it is
// part of every cache key and saved-run key.

import { MAX_CONVERSE_QUESTIONS, MAX_TITLE_WORDS } from "./constants";
import { type ConvTurn, questionsAsked, transcriptForPrompt } from "./converse";
import type { Decision, Fact, Persona, RouteKind, Rule } from "./types";

export const PROMPT_VERSION = "2026-10-09.6";
/** The think-out-loud parse prompt has its own version, so changing it leaves every other recording valid. */
export const PARSE_PROMPT_VERSION = "2026-10-12.1";
/** The conversation prompt (docs/STAGE-6.md) and the title prompt, each versioned on its own. */
export const CONVERSE_PROMPT_VERSION = "2026-10-13.2";
export const TITLE_PROMPT_VERSION = "2026-10-13.2";

function head(p: Persona): string {
  return `${p.name} (${p.pronouns}) is a ${p.role.toLowerCase()} at ${p.company}, ${p.company_blurb}. ${p.first_name} runs about ${p.fleet_size} AI agents across ${p.projects.length} projects: ${p.projects
    .map((x) => `${x.name} (${x.blurb})`)
    .join("; ")}.`;
}

function guidance(p: Persona, rules: Rule[], facts: Fact[]): string {
  const r = rules.map((x) => `- ${x.text}`).join("\n") || "(none)";
  const f =
    facts
      .map(
        (x) =>
          `- ${x.text} (applies to: ${x.scope === "all" ? "all projects" : `the ${x.scope} project only`}; source: ${x.source})`,
      )
      .join("\n") || "(none)";
  const n = p.how_to_work_with_me.map((x) => `- ${x}`).join("\n");
  return `=== ${p.first_name}'s written rules ===\n${r}\n\n=== Standing facts about how ${p.first_name} decides ===\n${f}\n\n=== ${p.first_name}'s "how to work with me" note ===\n${n}`;
}

function decisionBlock(d: Decision): string {
  const opts = d.options
    .map(
      (o) =>
        `${o.key}. ${o.label}${o.agent_label ? ` (the agent called it "${o.agent_label}")` : ""}${o.key === d.recommended ? " (Recommended)" : ""}${o.description ? ` - ${o.description}` : ""}`,
    )
    .join("\n");
  return `=== The waiting decision ===\nid: ${d.id}\nProject: ${d.project}\nAsked by: ${d.agent.join(" > ")} (waiting ${d.waiting_minutes} minutes; ${d.unblocks} other agents blocked on it)\nQuestion, exactly as the agent asked it: ${d.question}\nOptions:\n${opts}\nContext from the agent: ${d.context}`;
}

export function routePrompt(
  p: Persona,
  rules: Rule[],
  facts: Fact[],
  d: Decision,
): string {
  const n = p.first_name;
  return `You are Bug Me, a chief of staff that sits between one person and their fleet of AI agents. ${head(p)}

An agent has stopped to ask ${n} something. Decide how it should be handled, one of three ways:
- settle: Bug Me decides it without ${n}. Only when one of ${n}'s written rules explicitly clears this kind of decision AND the chosen action can be fully undone at little or no cost. Put the option you would pick in settle_option and copy the clearing rule, exactly as written, into clearing_rule.
- check_in: bring it to ${n} as a quick check, answerable in seconds.
- decide: bring it to ${n} as a substantive decision that needs their reasoning: costly, hard to undo, external, about a person, or covered by a rule that says it is ${n}'s.
When unsure between two routes, choose the one that involves ${n} more. Nothing easy should reach ${n}, and nothing consequential should be settled without them.
If something would otherwise be eligible to settle but one of ${n}'s standing facts bears on the choice, bring it as at least a quick check and quote that fact; anything that needs a substantive decision stays one.
Accepting or scheduling a meeting on ${n}'s behalf commits them to other people: declining later is rude to the organizer, and a meeting they didn't want costs their time. Treat it as hard to undo, and settle it only if you are extremely confident ${n} would want it.

Also judge the question itself, as a reviewer of the agent's work. problem is "fine" when it is necessary, clear and consistent with the rules; otherwise one of: recommendation_conflicts_with_written_rule (the recommended option or the framing goes against a written rule or standing fact), should_investigate_before_asking (the agent could have settled it by reading code, docs or history), not_enough_context_to_decide, unplanned_scope, options_unusable (opaque, indistinguishable, or written in the agent's private jargon), other.

Then fill in:
- rule_quoted: the written rule this decision turns on, copied exactly, or "".
- fact_quoted: the standing fact it turns on, copied exactly, or "".
- why_here: one plain sentence to ${n} saying why this is being settled, brought as a quick check, or brought as a decision, quoting the rule or fact if there is one. Do not reveal which option you expect ${n} to pick.
- headline: the question in ${n}'s terms, as one short question of at most 20 words, with no agent jargon or internal identifiers.
- in_your_terms: a briefing of two to four sentences for ${n}: what actually changes for users, customers or the team under each option, with no agent jargon or internal identifiers. Keep it neutral; give both options a fair hearing; do not recommend.
- briefing: two short plain sentences for ${n} on what is going on, before the question: what the work is and why the choice has come up now. No agent jargon or internal identifiers. Do not recommend.
- Every field that names an option (settle_option, guess, conflicts, send_down) holds the option's key letter alone, such as "A".
- option_notes: an entry under every option's key, including an option that means waiting, reviewing first or doing nothing. pros and cons: at most two each, each a short phrase of at most 12 words in ${n}'s terms, using only facts in the decision. consequence: one short line on what choosing it costs in money, time or work for the agents (for example "$212, refundable for 24 hours" or "Six agents wait another week"), only when the decision states it; otherwise "". Keep every note neutral: nothing may hint at which option you expect ${n} to pick.
- guess: your probability that ${n} picks each option. Be honestly calibrated; ${n}'s own rules and standing facts count for more than the agent's recommendation. The probabilities sum to 1.
- conflicts: each option that would go against what one of ${n}'s standing facts or written rules says ${n} wants done, with that fact or rule copied exactly in quoted. A rule that only says a kind of decision must come to ${n} is satisfied by ${n} deciding it, so it never makes an option a conflict. Usually empty.
- send_down: for each option, one or two sentences to the asking agent, in its own terms, saying exactly what to do next if ${n} picks it.
- reversible and cost: for the option you expect, whether it can be undone (yes / partly / no) and what it costs (cheap / moderate / expensive).

${guidance(p, rules, facts)}

${decisionBlock(d)}

Reply with the JSON object only.`;
}

/**
 * The routing answer's JSON schema for one decision. Every field that names an option is an enum of
 * that decision's option keys, so structured output can only produce "A" or "B", never the option's
 * label (left free, the model sometimes copies "A. Send now" from the decision block).
 */
export function routeSchema(keys: string[]) {
  const key = { type: "string", enum: keys } as const;
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "route",
      "settle_option",
      "reversible",
      "cost",
      "clearing_rule",
      "rule_quoted",
      "fact_quoted",
      "why_here",
      "headline",
      "in_your_terms",
      "briefing",
      "option_notes",
      "problem",
      "guess",
      "conflicts",
      "send_down",
    ],
    properties: {
      route: { type: "string", enum: ["settle", "check_in", "decide"] },
      settle_option: { type: "string", enum: ["", ...keys] },
      reversible: { type: "string", enum: ["yes", "partly", "no"] },
      cost: { type: "string", enum: ["cheap", "moderate", "expensive"] },
      clearing_rule: { type: "string" },
      rule_quoted: { type: "string" },
      fact_quoted: { type: "string" },
      why_here: { type: "string" },
      headline: { type: "string" },
      in_your_terms: { type: "string" },
      briefing: { type: "string" },
      option_notes: {
        type: "object",
        additionalProperties: false,
        required: keys,
        properties: Object.fromEntries(
          keys.map((k) => [
            k,
            {
              type: "object",
              additionalProperties: false,
              required: ["pros", "cons", "consequence"],
              properties: {
                pros: { type: "array", items: { type: "string" } },
                cons: { type: "array", items: { type: "string" } },
                consequence: { type: "string" },
              },
            },
          ]),
        ),
      },
      problem: {
        type: "string",
        enum: [
          "fine",
          "recommendation_conflicts_with_written_rule",
          "should_investigate_before_asking",
          "not_enough_context_to_decide",
          "unplanned_scope",
          "options_unusable",
          "other",
        ],
      },
      guess: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["option", "p"],
          properties: { option: key, p: { type: "number" } },
        },
      },
      conflicts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["option", "quoted"],
          properties: { option: key, quoted: { type: "string" } },
        },
      },
      send_down: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["option", "instruction"],
          properties: { option: key, instruction: { type: "string" } },
        },
      },
    },
  } as const;
}

export function factPrompt(
  p: Persona,
  rules: Rule[],
  facts: Fact[],
  d: Decision,
  choice: string,
  reason: string,
  waiting: Decision[],
  /** A thread that ended outside the listed options (docs/STAGE-6.md): Jordan's own course, or the
   *  question rejected. Absent for a listed option, whose prompt is unchanged (and so its recordings). */
  outside?: { kind: "other" | "rejected"; course: string },
): string {
  const n = p.first_name;
  const chosen = d.options.find((o) => o.key === choice);
  const picked = outside
    ? outside.kind === "other"
      ? `Neither option. ${n}'s own course instead, in ${n}'s words: ${outside.course}`
      : `${n} rejected the question itself, in ${n}'s words: ${outside.course}`
    : `${choice}${chosen ? ` (${chosen.label})` : ""}${choice !== d.recommended ? ", against the agent's recommendation" : ""}`;
  const factList =
    facts.map((f) => `${f.id}: ${f.text}`).join("\n") || "(none)";
  const waitList =
    waiting.map((w) => `${w.id}: ${w.question}`).join("\n") || "(none)";
  return `You are Bug Me, a chief of staff that sits between one person and their fleet of AI agents. ${head(p)}

${n} just answered a decision and said why. Your job: decide whether the reason states standing guidance that should shape ${n}'s future decisions, and if so, write it down as one short fact.

- kind: "add" for new guidance; "replace" when it updates or contradicts one of the existing standing facts listed below (put that fact's id in replaces); "none" when the reason is about this case only ("just this once", a misclick, something specific to this one decision) or says nothing durable.
- text: the guidance as one sentence about ${n}, in the present tense, as general as the reason supports and no more. Never add preferences ${n} did not state. "" when kind is none.
- scope: the project id it applies to, or "all" when it is about ${n} in general (their schedule, constraints or working style) rather than one project.
- confirm: one short line to ${n} confirming what you understood, starting with "So".
- may_affect: the ids of decisions, from the list below, whose handling this guidance would plausibly change. Usually zero to three.

${guidance(p, rules, facts)}

=== Existing standing facts, with ids ===
${factList}

${decisionBlock(d)}

=== ${n}'s answer ===
Picked: ${picked}
Reason, in ${n}'s words: ${reason}

=== The other decisions in the fleet's queue (id: question) ===
${waitList}

Reply with the JSON object only.`;
}

export const FACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "replaces", "text", "scope", "confirm", "may_affect"],
  properties: {
    kind: { type: "string", enum: ["add", "replace", "none"] },
    replaces: { type: "string" },
    text: { type: "string" },
    scope: { type: "string" },
    confirm: { type: "string" },
    may_affect: { type: "array", items: { type: "string" } },
  },
} as const;

/**
 * A clarifying question about one decision, answered only from what the asking agent provided. When
 * the answer is not there, say so: the question then goes back to the agent instead of being guessed.
 */
export function askPrompt(p: Persona, d: Decision, question: string): string {
  const n = p.first_name;
  return `You are Bug Me, a chief of staff that sits between one person and their fleet of AI agents. ${head(p)}

${n} is looking at a decision an agent brought and asked a question before deciding. Answer it using only the information below: the agent's question, its context and the options. Do not guess, and do not add facts that are not there.

- answerable: true only when the information below actually answers the question.
- answer: when answerable, two or three plain sentences in ${n}'s terms, with no agent jargon or internal identifiers. When not answerable, one sentence saying plainly what is missing, so the agent can be asked for it. Never say which option ${n} should pick.

${decisionBlock(d)}

=== ${n}'s question ===
${question}

Reply with the JSON object only.`;
}

export const ASK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answerable", "answer"],
  properties: { answerable: { type: "boolean" }, answer: { type: "string" } },
} as const;

/**
 * Thinking out loud: pick out of the person's own words which option they lean to, their reasons, any
 * conditions and any questions. Every mark is an exact quote; code drops any that isn't (parse.ts).
 */
export function parsePrompt(p: Persona, d: Decision, text: string): string {
  const n = p.first_name;
  return `You are Bug Me, a chief of staff that sits between one person and their fleet of AI agents. ${head(p)}

${n} is looking at a decision an agent brought and is thinking out loud about it, by voice or typing. The words may be unfinished, rambling or self-correcting. Read them and pick out:

- choice: the option key ${n} has settled on, judged from the whole text (a later "actually…" overrides an earlier lean). "other" when ${n} wants a course that is neither option. "none" when ${n} hasn't chosen yet, is only weighing, or only asked questions. Never infer a choice ${n} did not express.
- marks: phrases copied exactly, character for character, from ${n}'s words, each with a kind:
  - "choice": the words where ${n} states the choice, or the different course when choice is "other" (only when choice is not "none");
  - "why": a reason for the choice;
  - "but": a condition, caveat or extra instruction that goes with it ("as long as…", "but also…");
  - "ask": a question ${n} wants answered before or while deciding.
  Mark whole clauses, not single words. Leave filler ("hmm", "honestly") unmarked. At most 8 marks; none is fine.

${decisionBlock(d)}

=== ${n}'s words, exactly ===
${text}

Reply with the JSON object only.`;
}

/** The parse schema for one decision: choice is one of its option keys, "other" or "none". */
export function parseSchema(keys: string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["choice", "marks"],
    properties: {
      choice: { type: "string", enum: [...keys, "other", "none"] },
      marks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "quote"],
          properties: { kind: { type: "string", enum: ["choice", "why", "but", "ask"] }, quote: { type: "string" } },
        },
      },
    },
  } as const;
}

/** What the conversation knows about the routed card: the route and why it came to the person. Never
 *  the sealed guess or the source label, so a recorded thread replays whatever the card's provenance. */
export interface ConverseCard {
  route: RouteKind;
  why_here: string;
}

/**
 * One turn of the decision conversation. Claude reads the whole thread, returns its current reading of
 * everything the person has said (the ledger, every quote exact), and writes Bug Me's next turn. Code
 * then checks the quotes and decides what actually happens next (converse.ts, `advance`).
 */
export function conversePrompt(p: Persona, rules: Rule[], facts: Fact[], d: Decision, c: ConverseCard, turns: ConvTurn[]): string {
  const n = p.first_name;
  const asked = questionsAsked(turns);
  return `You are Bug Me, a chief of staff that sits between one person and their fleet of AI agents. ${head(p)}

An agent brought ${n} a decision. Bug Me opened the conversation by showing ${n} the briefing, why it came to ${n}, the question and the options. ${n} is now talking it through with you, typing or speaking, in turns. Your job on every turn: read the whole conversation, write down what you heard (the ledger), and write Bug Me's next turn.

How Bug Me talks:
- At most two short, plain sentences (an explanation, below, may run longer), and at most one question. No agent jargon or internal identifiers.
- Never say which option you expect ${n} to pick or which one the agent recommended (${n} sees that only after deciding), never argue for an option, and never add anything ${n} did not say.
- Don't raise conflicts with ${n}'s rules or standing facts: Bug Me checks the answer against ${n}'s record separately, after ${n} confirms.
- Persist a little, but don't nag. If ${n} chose (by clicking or in words) but gave no reason, ask lightly why, once. Don't ask about minor details. Bug Me has asked ${asked} of at most ${MAX_CONVERSE_QUESTIONS} questions in this conversation.
- If ${n} asks a question, answer it using only the agent's material below. If the material doesn't say, say plainly that you don't know and will ask the agent. If ${n} has already chosen and said why, answer in a few words and read back in the same reply; don't ask whether the answer changes their mind.
- If ${n} says to stop asking ("just do it", "no more questions"), stop: read back.
- Once you know the choice and why (or ${n} declined to say), read the outcome back in one sentence that names the choice and any conditions, ending with "Right?". That is next "confirm". The read-back uses only ${n}'s choice and ${n}'s own words: no details, plans or reasons ${n} did not say.
- If Bug Me's last turn was a read-back and ${n} agreed, next is "close" and the reply is a few words ("Sending that now."). An explanation in between doesn't change that: a yes after it still answers the read-back. If ${n} corrected it, update the ledger and read back again.
- If ${n} wants neither option but a different course, that is choice "other". If ${n} rejects the question itself or its framing, that is choice "reject". Either way, quote ${n}'s words for it in course.
- next is "ask" when Bug Me's reply asks ${n} something it still needs, such as which way they lean or why.
- If ${n} pressed "Huh?" or says Bug Me isn't making sense ("I don't follow", "what does that even mean?"), Bug Me's translation missed: re-present the last thing Bug Me showed (the briefing and question, or Bug Me's last turn) in plain, everyday English. Say what is going on, what each option would actually do, define any term ${n} might not know, and end by asking the question again, simply. Restating the agent's material is the point, but add nothing it doesn't say; if it doesn't say what an option would do, say so plainly. Up to five short sentences; still don't lean toward an option. That is next "explain". Don't apologize at length. Asking what Bug Me meant is feedback of kind "unclear", not a question for the agent and not a reason: don't also list it under questions, why or conditions.

The ledger, always your reading of the whole conversation so far (a later correction replaces what it corrects):
- choice: the option key ${n} has settled on, "other", "reject", or "none" if not yet. "(clicked option X)" means ${n} clicked X; words in the same turn that say otherwise win.
- choice_quote: the words where ${n} stated the choice, if in words; otherwise quote "".
- course: for "other" or "reject", ${n}'s words for it; otherwise quote "".
- action: for "other" or "reject", an imperative of at most five words naming what will happen ("Test both with customers"); otherwise "".
- why: ${n}'s reasons. conditions: caveats or extra instructions that go with the choice ("as long as…", "but note…").
- questions: ${n}'s questions, each with answerable (true only when the material below answers it) and answer (your answer, or "").
- feedback: what ${n} said about the question itself, each with kind "priority" (more or less urgent than it was framed), "routing" (it should or shouldn't have come to ${n}) or "unclear" (Bug Me's wording didn't make sense to ${n}). A "Huh?" press has no words, so it is never quoted.
- no_more_questions: true when ${n} asked Bug Me to stop asking.
Every quote is copied exactly, character for character, from one of ${n}'s turns, with that turn's number from the conversation below. Mark whole clauses, not single words.

${guidance(p, rules, facts)}

${decisionBlock(d)}

=== Why it came to ${n} (${c.route === "decide" ? "a decision" : c.route === "check_in" ? "a quick check" : "settled"}) ===
${c.why_here}

=== The conversation so far ===
${transcriptForPrompt(d, turns, n)}

Reply with the JSON object only.`;
}

/** The conversation's schema for one decision: choice is one of its option keys, "other", "reject" or "none". */
export function converseSchema(keys: string[]) {
  const quote = {
    type: "object",
    additionalProperties: false,
    required: ["turn", "quote"],
    properties: { turn: { type: "integer" }, quote: { type: "string" } },
  } as const;
  return {
    type: "object",
    additionalProperties: false,
    required: ["reply", "next", "ledger"],
    properties: {
      reply: { type: "string" },
      next: { type: "string", enum: ["ask", "confirm", "close", "explain"] },
      ledger: {
        type: "object",
        additionalProperties: false,
        required: ["choice", "choice_quote", "course", "action", "why", "conditions", "questions", "feedback", "no_more_questions"],
        properties: {
          choice: { type: "string", enum: [...keys, "other", "reject", "none"] },
          choice_quote: quote,
          course: quote,
          action: { type: "string" },
          why: { type: "array", items: quote },
          conditions: { type: "array", items: quote },
          questions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["turn", "quote", "answerable", "answer"],
              properties: { turn: { type: "integer" }, quote: { type: "string" }, answerable: { type: "boolean" }, answer: { type: "string" } },
            },
          },
          feedback: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["turn", "quote", "kind"],
              properties: { turn: { type: "integer" }, quote: { type: "string" }, kind: { type: "string", enum: ["priority", "routing", "unclear"] } },
            },
          },
          no_more_questions: { type: "boolean" },
        },
      },
    },
  } as const;
}

/**
 * A short emoji and title for one decision, from the fast model (David, 2026-10-12), plus, per option,
 * what having done it reads like, for the list of things Bug Me settled. Display only: never routing.
 */
export function titlePrompt(d: Decision): string {
  const opts = d.options.map((o) => `${o.key}. ${o.label}${o.description ? ` - ${o.description}` : ""}`).join("\n");
  return `Give this question from an AI agent a short label for a busy person's to-do list.

- emoji: exactly one emoji that pictures what the decision is about.
- title: what is being decided, in at most ${MAX_TITLE_WORDS} words (count them; anything longer is rejected, so drop "where" words like "in the SDK repo"), sentence case, no final period, no agent jargon or internal identifiers. Example: "Rename the v2 user field" (5 words).
- done: for each option key, what was done if that option was taken, in the past tense, in at most ${MAX_TITLE_WORDS} words (count them), keeping any count from the question. Leave out where and how ("on a branch", "after CI"). Example: "Deleted 41 merged branches" (4 words).
- labels: for each option key, the option as the busy person would say it, in at most ${MAX_TITLE_WORDS} words (count them), starting with a verb, sentence case, no final period. Plain everyday words: no agent jargon, codes, version names or internal identifiers; say what the option does instead. Keep names and numbers the person would recognize (a flight time, a field name they'd type). Example: "Keep the old tax table" for "Keep T-19 mapping".

Question: ${d.question}
Options:
${opts}
Context: ${d.context}

Reply with the JSON object only.`;
}

export function titleSchema(keys: string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["emoji", "title", "done", "labels"],
    properties: {
      emoji: { type: "string" },
      title: { type: "string" },
      done: { type: "object", additionalProperties: false, required: keys, properties: Object.fromEntries(keys.map((k) => [k, { type: "string" }])) },
      labels: { type: "object", additionalProperties: false, required: keys, properties: Object.fromEntries(keys.map((k) => [k, { type: "string" }])) },
    },
  } as const;
}
