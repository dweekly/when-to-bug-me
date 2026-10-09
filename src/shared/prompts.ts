// The two prompts and their output schemas. Ported from the private bench's question critic
// (CRITIQUE_INSTRUCTIONS: judge whether a question should reach the person as asked, quoting a written
// rule exactly) and its person-model prompt (calibrated probability per option), with the person's
// name made a parameter and the three routes added. Bump PROMPT_VERSION on any wording change: it is
// part of every cache key and saved-run key.

import type { Decision, Fact, Persona, Rule } from "./types";

export const PROMPT_VERSION = "2026-10-09.6";

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
        `${o.key}. ${o.label}${o.key === d.recommended ? " (Recommended)" : ""}${o.description ? ` - ${o.description}` : ""}`,
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
): string {
  const n = p.first_name;
  const chosen = d.options.find((o) => o.key === choice);
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
Picked: ${choice}${chosen ? ` (${chosen.label})` : ""}${choice !== d.recommended ? ", against the agent's recommendation" : ""}
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
