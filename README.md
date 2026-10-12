# Bug Me

**A chief of staff for people who run fleets of agents.** Every question your agents raise flows into Bug Me instead of interrupting you. It settles what your written rules already cover (and only if it is reversible and cheap), puts the rest in the order to work them, briefs you before it asks, takes your answer in one click or one sentence, asks you why when your answer surprises it, and turns your reasons into guidance every agent follows from then on.

**Try it:** [bugme.weekly.org](https://bugme.weekly.org), live Claude behind a daily spend cap. This repo is the working prototype for an Anthropic Labs take-home.

Plans: [`docs/BUILD-PLAN.md`](docs/BUILD-PLAN.md) (the prototype's first stage; fresh as of 2026-10-09), [`docs/STAGE-2.md`](docs/STAGE-2.md) (home and focus views, Not now, tours, the explainer; fresh as of 2026-10-09), [`docs/STAGE-3.md`](docs/STAGE-3.md) (piles on Home, the decision card, always-on voice; fresh as of 2026-10-11), [`docs/STAGE-4.md`](docs/STAGE-4.md) (think out loud: one place to talk a decision through, marked up as Bug Me reads it; fresh as of 2026-10-12).

> **Everything here is synthetic.** Jordan Okafor, Larkspur, the twenty agents and all 28 of their questions are made up. No real agent receives anything Bug Me "sends down".

## Try it in two minutes

The front page is a short explainer; each tour card opens a guided tour of the real app that points and lets you click. Or open the app and play Jordan, a staff engineer whose fleet raised 28 questions overnight:

1. **Home** shows the night as piles, one per project, and recommends where to start ("Start with Launch: 11 questions, about 23 minutes, because answers here unblock the most agents"). Four were settled for Jordan without asking, each reversible, cheap and cleared by a written rule.
2. **A decision card** briefs you first (what is going on, and why it is yours, quoting the rule), then asks. The options sit side by side, each with its own pros, cons and cost (and, where there is one, its line of the payload or its clickable prototype).
3. **Think out loud.** Say or type it the way you would to a colleague: which way you lean, why, any "but…", any question. As you go, Bug Me marks your words: the choice lit, reasons, conditions and questions underlined, each an exact quote. Questions are answered under your words from what the agent provided. Or just click an option. Nothing goes out until **Send**, which says what it will send ("Send: keep user_id, with one condition"). Bug Me's guess stays sealed until then.
4. If your answer surprises it, Bug Me asks **"I'm curious: why?"** Your reason becomes proposed guidance; keep it, and the waiting decisions it touches are re-checked with the cause shown (the 7:30am Berlin invite is reframed by a reason given on the flight).
5. **The clay firefly** in the corner shows the morning's glow (brighter as you give real reasons). Click it to talk: it listens across cards, shows the words it hears, and puts them in the card's think-out-loud box.

Also worth a click: edit a written rule and watch decisions re-route; undo something in **Decided for you**, or mark it "this shouldn't have come to me"; the settings redesign card, where both options are clickable prototypes.

## What is live, what is recorded, what is code

Every card carries a badge saying where its routing came from.

| Badge | Meaning |
| --- | --- |
| **live Claude** | A call to `claude-opus-5-5` (low effort, JSON-schema output) made just now. |
| **cached Claude** | An earlier live answer to the byte-identical request. |
| **recorded Claude run** | A live answer recorded with `npm run record` and packaged with the Worker. Replayed only on an exact request match. The opening morning (all 28 routes, briefings and option notes) and the tours' scripted reasons are recorded, so the first view is fast and costs nothing; everything a visitor types or edits goes to live Claude. |
| **code stand-in** | The deterministic keyword-matching fake (`src/shared/fakeModel.ts`), used for tests and when `FAKE_MODEL` is set. Not judgment. |

Plain code, never the model, decides: the piles, their order and the recommended one; whether a "settle" is allowed (see below); when to push back, ask why, or propose guidance (`src/shared/lifecycle.ts`); and which decisions to re-route.

When live calls are off (no key, or the daily budget is spent), only recorded answers can be evaluated. Anything else shows "couldn't evaluate", and the scripted examples offer their recorded reason behind a clearly labeled button. Nothing is silently substituted.

## How it works

```
 browser (public/, src/page/)                Cloudflare Worker (src/worker/)
 ─────────────────────────────               ───────────────────────────────────────────────
 agenda, cards, rules, record   ── /api/queue ──▶  fixtures (bundled, never served)
 (state in localStorage)        ── /api/route ──▶  routePrompt ─▶ model.ts: fake │ recorded │ cache │ live
                                ── /api/answer ─▶  unseal guess (AES-GCM, bound to decision + options + context)
                                ── /api/fact ───▶  factPrompt ─▶ proposed guidance + decisions to re-route
                                ── /api/ask ────▶  askPrompt ─▶ an answer from the agent's context, or what is missing
                                                   SpendCounter Durable Object: reserve before each live call
```

- **Four prompts** (`src/shared/prompts.ts`), ported from the question critic and person model in the research behind the proposal. *Route* returns the route, a headline, a two-sentence briefing and, per option, up to two pros, two cons and a consequence, all in the person's terms; the rule or fact it turned on (quoted exactly); a calibrated guess per option; options that contradict the person's record; and what each option tells the asking agent. *Fact* turns a stated reason into new guidance, a replacement for an existing fact, or "nothing durable". *Ask* answers a clarifying question only from what the agent provided, or says what is missing. *Parse* reads the person thinking out loud and returns their choice (an option, something else, or none yet) and marks, each `{kind, quote}` with kind choice, why, but or ask; code keeps a mark only if its quote is a literal substring of the words. It has its own prompt version, so changing it leaves the other recordings valid.
- **Structured output, constrained per decision.** Each routing request carries a JSON schema built for that decision: every field that names an option is an enum of its keys, and the per-option notes are an object with a required entry for each option. With free strings, about one live answer in seven named options by their label or skipped an option; the schema makes both impossible. Code then validates every answer before it is shown, cached or recorded.
- **The settle invariant is code.** Bug Me settles alone only what is reversible, cheap, and cleared by a written rule. Each decision carries hand-authored, conservative bounds per option; code accepts the model's "settle" only when the chosen option is within them and the clearing rule is the exact text of a current rule, and otherwise brings the decision to the person, saying why. In the recorded run Claude tried to settle the $212 6:05am flight under "book the cheapest reasonable option"; code brought it back. Every quote is checked against the current rules and facts, and a quote that doesn't occur is dropped.
- **Hidden guesses.** The guess, conflicts and send-down text are sealed with AES-GCM (fresh nonce, bound to the decision id, its options and the rules/facts version) before they reach the page. `/api/answer` opens them only for a valid choice. This prevents disclosure before the answer in ordinary use; with a public repo and a stateless endpoint it is not an adversarially blind experiment.
- **Cost controls.** Exact-match recorded runs and a response cache first; then a Durable Object that atomically reserves a worst-case charge per live call against a daily cap (`DAILY_SPEND_CAP_USD`), reconciled to actual usage; explicit `max_tokens`, a timeout and no automatic retries; only known decision ids; bounded request sizes and re-route fan-out. Every number is in `src/shared/constants.ts` with its source.

## Does a captured reason actually move the routing?

`npm run eval` asks live Claude, three fresh times per condition (no cache, no recorded answers), whether a reason the person gave changes how the decisions it should touch are routed, and leaves the others alone. Expected outcomes were written before running; the command fails unless every condition passes every trial. Latest run, 2026-10-09, on prompt version 2026-10-09.6 (`results/captures/eval-2026-10-10T00-02-47-728Z.json`, $0.92):

| Condition | Expected | Passed |
| --- | --- | --- |
| Berlin sync, default facts | a quick check for Jordan, not accepted alone (a meeting is hard to undo); guess leans accept | 3/3 |
| Berlin sync, after the flight reason | not settled; guess favors declining; quotes the newly kept fact | 3/3 |
| Berlin sync, after a *paraphrased* flight reason (whole loop) | fact proposed; not settled; guess favors declining | 3/3 |
| Formatter run (control), after the flight reason | still settled | 3/3 |
| Webhook rename, default facts | a decision for Jordan | 3/3 |
| Webhook rename, after the API rename reason | guess favors keeping the name at 0.6 or more; quotes the newly kept fact | 3/3 |
| Free tier (control), after the API rename reason | unchanged; does not quote the new fact | 3/3 |

These are designed demonstration checks on fixtures written for the demo, not an accuracy estimate.

`npm run eval:parse` checks the parse prompt the same way: six narrations (all four kinds of mark, a bare choice, a change of mind, only weighing with a question, neither option, yes with a condition), three fresh live calls each, expectations written first. It fails unless every trial gets the choice and every expected kind of mark with no mark dropped as inexact. Latest run, 2026-10-12, prompt 2026-10-12.1: 6/6 narrations, 18/18 trials, 1.2–2.4 s per parse, $0.12 (`results/captures/eval-parse-2026-10-12T05-22-13-021Z.json`).

## Run it

Requirements: Node 22, Python 3, and [gitleaks](https://github.com/gitleaks/gitleaks) for the secret scan.

```bash
npm ci
python3 -c "import secrets,base64;print('SEAL_KEY='+base64.b64encode(secrets.token_bytes(32)).decode())" > .dev.vars
npm run dev:fake          # http://localhost:8787 on the deterministic stand-in
npm run dev               # recorded Claude runs; put your own key in .dev.vars as ANTHROPIC_API_KEY for live calls
```

Checks:

```bash
npm run typecheck && npm test   # unit tests
npm run e2e                     # Playwright: desktop, phone and 320px on the stand-in, plus every tour on a keyless server with the recorded run
python3 scripts/scan.py         # secrets, private-data denylist, data-file rule, gitleaks (fails closed)
npm run record -- --dry-run     # what re-recording would call; drop --dry-run to record (costs money)
sh scripts/install-hooks.sh     # pre-push hook: scan + tests
```

## Limitations

- **The evidence boundary.** In the research behind the proposal, a check that quotes the person's written rules, ordering with reasons, and hidden guesses all worked; and with one deciding fact supplied, Opus 5.5 got 11 of 17 previously missed decisions right, against 0 without it. Nothing measured shows that a model can predict when a person will reject a strong agent's recommendation. The prototype does not claim it.
- One synthetic persona and a fixed set of 28 decisions; no real agents, intake or send-down.
- Visitor state lives in the browser only. The record can be exported as JSON.
- Re-routing after kept guidance checks decisions that share a topic tag with the answered one plus the model's suggestions, capped; it can miss a decision that shares neither.
- Voice uses the browser's speech recognition (Chrome, Safari); in Chrome the audio goes to the browser's speech service, which the page says beside the firefly. Typing always works.
- Answers, guidance and set-asides are simulated: nothing reaches a real agent, and "Ask the agent" gathers nothing new.

## How this was built

Designed by David E. Weekly, built with Claude Code (Claude Opus 5.5) as the implementing agent, from a written product proposal and a plan per stage. Each plan was reviewed once by OpenAI Codex before building, and every diff by Codex before merge. Design changes went through quick mockups first (two versions each of Home and the decision card, picked by David) before any code. Claude Code wrote the code, fixtures and tests; subagents built the two settings prototypes, the secret scanner and CI, and test suites in parallel. Each recorded run was made against the live API for about a dollar.

See also: [`ROADMAP.md`](ROADMAP.md) (fresh as of 2026-10-11), [`CHANGELOG.md`](CHANGELOG.md) (fresh as of 2026-10-11), [`CLAUDE.md`](CLAUDE.md) (guardrails for agents working here).
