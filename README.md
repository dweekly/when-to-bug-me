# Bug Me

**A chief of staff for people who run fleets of agents.** Every question your agents raise flows into Bug Me instead of interrupting you. It settles what it safely can, brings you only the decisions that need you, one at a time and in your terms, asks you why, and turns your reasons into guidance every agent follows from then on.

This repo is the working prototype for an Anthropic Labs take-home. Status and plan: [`docs/BUILD-PLAN.md`](docs/BUILD-PLAN.md) (fresh as of 2026-10-09).
Stage 2 (home and focus views, Not now, tours, explainer): [`docs/STAGE-2.md`](docs/STAGE-2.md) (fresh as of 2026-10-09). Stage 3 (piles on Home, a decision card answered at a glance, always-on voice): [`docs/STAGE-3.md`](docs/STAGE-3.md) (fresh as of 2026-10-09).

> **Everything here is synthetic.** Jordan Okafor, Larkspur, the twenty agents and all 28 of their questions are made up. No real agent receives anything Bug Me "sends down".

## Try it in two minutes

You play Jordan, a staff engineer, on a morning when the fleet raised 28 questions overnight.

1. Look at the agenda: each question is routed one of three ways (**settled for you**, **quick check-in**, **your decision**), with the reason and the rule it turned on. The order is code: projects whose answers unblock the most agents come first.
2. Follow the hint and answer the 6:05am flight question the way you actually would. Bug Me's guess stays sealed until you answer.
3. If your answer surprises it, Bug Me asks **"I'm curious: why?"**
4. Your reason becomes proposed guidance. Keep it, and watch the waiting decisions it touches re-route, with the cause shown (the 7:30am Berlin sync that Bug Me had accepted for you comes back to you).

Also worth a click: edit a written rule and watch decisions re-route; undo something in **Decisions made for you**, or mark it "you should have asked me" or "right to decide, wrong call"; the settings redesign card, where both options are clickable prototypes; the firefly, whose glow tracks the reasons you give.

## What is live, what is recorded, what is code

Every card carries a badge saying where its routing came from.

| Badge | Meaning |
| --- | --- |
| **live Claude** | A call to `claude-opus-5-5` (low effort, JSON-schema output) made just now. |
| **cached Claude** | An earlier live answer to the byte-identical request. |
| **recorded Claude run** | A live answer recorded with `npm run record` and packaged with the Worker. Replayed only on an exact request match. The default morning and two scripted examples are recorded. |
| **code stand-in** | The deterministic keyword-matching fake (`src/shared/fakeModel.ts`), used for tests and when `FAKE_MODEL` is set. Not judgment. |

Plain code, never the model, decides: the agenda order and grouping; whether a "settle" is allowed (see below); when to push back, ask why, or propose guidance (`src/shared/lifecycle.ts`); and which decisions to re-route.

When live calls are off (no key, or the daily budget is spent), only recorded answers can be evaluated. Anything else shows "couldn't evaluate", and the scripted examples offer their recorded reason behind a clearly labeled button. Nothing is silently substituted.

## How it works

```
 browser (public/, src/page/)                Cloudflare Worker (src/worker/)
 ─────────────────────────────               ───────────────────────────────────────────────
 agenda, cards, rules, record   ── /api/queue ──▶  fixtures (bundled, never served)
 (state in localStorage)        ── /api/route ──▶  routePrompt ─▶ model.ts: fake │ recorded │ cache │ live
                                ── /api/answer ─▶  unseal guess (AES-GCM, bound to decision + options + context)
                                ── /api/fact ───▶  factPrompt ─▶ proposed guidance + decisions to re-route
                                                   SpendCounter Durable Object: reserve before each live call
```

- **Two prompts** (`src/shared/prompts.ts`), ported from the question critic and person model in the research behind the proposal. *Route* returns the route, a short headline and briefing in the person's terms, the rule or fact it turned on (quoted exactly), a calibrated guess per option, options that contradict the person's record, and what each option tells the asking agent. *Fact* turns a stated reason into new guidance, a replacement for an existing fact, or "nothing durable".
- **The settle invariant is code.** Bug Me settles alone only what is reversible, cheap, and cleared by a written rule. Each decision carries hand-authored, conservative bounds per option; code accepts the model's "settle" only when the chosen option is within them and the clearing rule is the exact text of a current rule, and otherwise brings the decision to the person, saying why. In the recorded run Claude tried to settle the $212 6:05am flight under "book the cheapest reasonable option"; code brought it back. Every quote is checked against the current rules and facts, and a quote that doesn't occur is dropped.
- **Hidden guesses.** The guess, conflicts and send-down text are sealed with AES-GCM (fresh nonce, bound to the decision id, its options and the rules/facts version) before they reach the page. `/api/answer` opens them only for a valid choice. This prevents disclosure before the answer in ordinary use; with a public repo and a stateless endpoint it is not an adversarially blind experiment.
- **Cost controls.** Exact-match recorded runs and a response cache first; then a Durable Object that atomically reserves a worst-case charge per live call against a daily cap (`DAILY_SPEND_CAP_USD`), reconciled to actual usage; explicit `max_tokens`, a timeout and no automatic retries; only known decision ids; bounded request sizes and re-route fan-out. Every number is in `src/shared/constants.ts` with its source.

## Does a captured reason actually move the routing?

`npm run eval` asks live Claude, three fresh times per condition (no cache, no recorded answers), whether a reason the person gave changes how the decisions it should touch are routed, and leaves the others alone. Expected outcomes were written before running. Latest run, 2026-10-09, on the current prompt (`results/captures/eval-2026-10-09T19-48-52-308Z.json`, $0.77):

| Condition | Expected | Passed |
| --- | --- | --- |
| Berlin sync, default facts | settled for Jordan | **1/3** |
| Berlin sync, after the flight reason | not settled; guess favors declining; quotes the newly kept fact | 3/3 |
| Berlin sync, after a *paraphrased* flight reason (whole loop) | fact proposed; not settled; guess favors declining | 3/3 |
| Formatter run (control), after the flight reason | still settled | 3/3 |
| Webhook rename, default facts | a decision for Jordan | 3/3 |
| Webhook rename, after the API rename reason | guess favors keeping the name at 0.6 or more; quotes the newly kept fact | 3/3 |
| Free tier (control), after the API rename reason | unchanged; does not quote the new fact | 3/3 |

These are designed demonstration checks on fixtures written for the demo, not an accuracy estimate. The one miss is real and open: since the prompt began stating each fact's scope, Claude sometimes brings the 7:30am Berlin invite as a quick check-in instead of accepting it, citing Jordan's standing preference for "a short written summary to a meeting when either would do". The recorded run the demo serves has it settled; whether to accept that reading or reword the fact is an open decision. The previous prompt version passed all 21 trials (`results/captures/eval-2026-10-09T19-34-07-594Z.json`).

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
npm run e2e                     # Playwright against wrangler dev with the stand-in, desktop and phone
python3 scripts/scan.py         # secrets, private-data denylist, data-file rule, gitleaks (fails closed)
npm run record -- --dry-run     # what re-recording would call; drop --dry-run to record (costs money)
sh scripts/install-hooks.sh     # pre-push hook: scan + tests
```

## Limitations

- **The evidence boundary.** In the research behind the proposal, a check that quotes the person's written rules, ordering with reasons, and hidden guesses all worked; and with one deciding fact supplied, Opus 5.5 got 11 of 17 previously missed decisions right, against 0 without it. Nothing measured shows that a model can predict when a person will reject a strong agent's recommendation. The prototype does not claim it.
- One synthetic persona and a fixed set of 28 decisions; no real agents, intake or send-down.
- Visitor state lives in the browser only. The record can be exported as JSON.
- Re-routing after kept guidance checks decisions that share a topic tag with the answered one plus the model's suggestions, capped; it can miss a decision that shares neither.
- Voice uses the browser's speech recognition where it exists (Chrome, Safari); typing always works.

## How this was built

Designed by David E. Weekly, built with Claude Code (Claude Opus 5.5) as the implementing agent, from a written product proposal and plan. The plan was reviewed once by OpenAI Codex before building; diffs are reviewed by Codex before merge. Claude Code wrote the code, fixtures and tests; subagents built the two settings prototypes, the secret scanner and CI, and the test suites in parallel. The recorded run was made against the live API for under a dollar per pass.

See also: [`ROADMAP.md`](ROADMAP.md) (fresh as of 2026-10-09), [`CHANGELOG.md`](CHANGELOG.md) (fresh as of 2026-10-09), [`CLAUDE.md`](CLAUDE.md) (guardrails for agents working here).
