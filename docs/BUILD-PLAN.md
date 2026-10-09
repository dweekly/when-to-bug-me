# Bug Me prototype: build plan

fresh as of 2026-10-09 · the PRD and sequenced plan for the hosted prototype. Forward-looking only; strike stages through as they merge.

## Why

The take-home asks for a working, interactive, hosted prototype that demonstrates the key idea of the product proposal ("Bug Me: a chief of staff for people who run fleets of agents"). The proposal's "A compelling v1" section describes a morning with v1 for an engineer running about twenty agents on three projects. The prototype makes that morning real, in a browser, with live Claude calls where the idea depends on judgment and plain code where it doesn't.

**Intent.** A reviewer who has read nothing else should, within two minutes and with no narration:

1. see a fleet's waiting questions, each routed one of three ways (settle it alone, a quick check-in, a substantive decision) with its reasons, quoting the person's written rules;
2. answer one against Bug Me's hidden guess;
3. be asked "I'm curious: why?";
4. watch that reason become a standing fact, and later questions visibly re-route because of it.

A different design serves the intent equally well if it delivers that loop live and honestly labeled.

**What the evidence lets the demo claim** (from the capability page and the private bench): a check that quotes the person's written rules works today; ordering the queue with reasons works today; guesses hidden until the person answers work today; with one deciding fact, Opus 5.5 got 11 of 17 previously missed decisions right, against 0 without it. **It must not imply** that the model predicts a person's rejections of a strong agent's recommendation. Nothing measured does.

## The persona

One synthetic person: **Jordan Okafor**, a staff engineer at **Larkspur**, a made-up company of about 120 people that makes a note-taking app. Jordan runs about twenty Claude Code agents across three projects:

- **launch**: the public API v2 launch (API, SDK, docs, settings page redesign);
- **billing**: moving invoicing to a new payments provider;
- **platform**: CI, dependencies, flaky tests, cleanup.

Everything about Jordan, Larkspur and the fleet is invented. The 18 task categories from the original brief are restated as engineering decisions; the HR item stays as one item (a draft peer review). The operations-manager version of the same categories is the "beyond code" next step and is not built.

## What the prototype shows (in priority order; build in this order)

1. **The routed agenda.** Every waiting decision, routed three ways by live Claude: settle alone, quick check-in, substantive decision. Each card says why it is here, quoting the written rule or standing fact it turned on, and restates the agent's question in Jordan's terms (the agent's original wording one click away). Ordering is code: grouped by project, projects ordered by how many agents their answers unblock, then by wait time; each change of project is named ("Three decisions on the launch, about 8 minutes").
2. **The why-loop.** Bug Me's guess is hidden until Jordan answers; the page never receives it in plaintext before then. Every answer asks for a basis (voice first, typing fallback). When the answer goes against a confident guess, Bug Me asks "I'm curious: why?". The reason becomes a standing fact (live Claude), which Jordan can keep, edit or discard; the waiting decisions it may affect are re-routed live, and every change is highlighted with its cause.
3. **Editable written rules.** Plain sentences, visible and editable in the page. Editing one re-routes the decisions it touches; reasons quote the rule.
4. **Decisions made for you.** What Bug Me settled alone, each with its reason and an undo, and two separate marks: "you should have asked me" (routing mistake) and "right to decide, wrong call" (judgment mistake). Decisions that did reach Jordan carry the opposite mark, "this shouldn't have come to me". The three are stored separately in the record.
5. **One explored-options decision.** The settings page redesign arrives with two clickable variants side by side, built far enough to click through, and a teach-back: "Say in a sentence what happens next if you choose B."
6. **The firefly glow.** The logo's glow brightens with real contributions (reasons given, overrides, rule edits, corrections); it rests when nothing waits; it dims a little only for real rubber-stamping (accepting a substantive decision with no basis), and looks sheepish when Jordan marks something "shouldn't have come to me". Private to the person; it never reacts to absence. Static logo plus CSS glow until the animated assets land.

Also shown, cheaply: **pushback** that quotes Jordan's own record when an answer contradicts a standing fact (rationed: at most a set number per session); **the record**, every guess made before an answer with the answer, the basis and the marks, exportable as JSON; a seeded **"how to work with me" note** in place of onboarding.

**Out:** onboarding, the pace monitor, multi-machine intake, a real agent fleet, multiple personas, accounts or server-side persistence (visitor state lives in browser storage), proceed-and-notify, group routing, and any claim that rejections are predicted.

## How it works

**Stack.** One Cloudflare Worker serves the static page (Workers static assets) and `/api/*`, in TypeScript with no frontend framework; the page is bundled with esbuild. The persona, rules, facts and decisions are JSON fixtures in `fixtures/`. Chosen because Cloudflare is the default host, wrangler is logged in, and the API key stays in the Worker.

**Model calls** (live Claude, labeled as such), both through `@anthropic-ai/sdk` with `claude-opus-5-5` at `effort: "low"` and a strict JSON schema in `output_config.format`, no tools:

1. **Route one decision.** In: the rules, the standing facts, the decision (project, agent chain, question, options, the agent's recommendation, short context). Out: `route` (settle / check_in / decide), `reversible`, `cost`, `clearing_rule` (the rule that explicitly lets Bug Me settle it, or empty), `rule_quoted`, `fact_quoted`, `why_here`, `in_your_terms`, `problem` (the question critic's categories), `guess` (a probability per option), `conflicts` (options that contradict a standing fact, with the fact quoted), and `send_down` (what each option tells the asking agent, in its own terms). Ported from the bench's question critic and person-model prompts with the person's name changed.
2. **Reason to fact.** In: the decision, the answer, the stated reason, the current facts, and one-line summaries of the waiting decisions. Out: a standing fact (`text`, `scope`), a one-line confirmation, and `may_affect`, the waiting decisions to re-route. Only those are re-routed, which bounds the cost of a fact to one call plus a few.

**Three routes, defined.** *Settle*: Bug Me picks an option itself (`settle_option`) and lists it under "Decisions made for you". *Check-in*: a one-screen card answered in seconds, basis optional, batched per project. *Decision*: a fuller briefing (both sides, explored options where they exist) and a basis is asked for; the agenda puts these first within a project.

**Code-enforced invariant.** Bug Me settles alone only what is reversible, cheap, and cleared by a written rule. The model's word is not enough: each fixture decision carries hand-authored, conservative bounds per option (`bounds: {reversible, cost_usd}`), and code accepts "settle" only when the chosen `settle_option` is within bounds (reversible, under a set dollar ceiling) **and** `clearing_rule` is the exact text of a current rule. Otherwise code downgrades the route to a check-in and annotates the card ("code adjusted this route", with the missing condition). Quotes of rules and facts are also checked against the current text, and a quote that does not occur is dropped rather than shown. What this guarantees is exactly those checks; it does not prove that arbitrary natural-language authorization is correct.

**Hidden guesses, structurally.** The Worker seals the guess, the conflicts and the send-down text with AES-GCM (fresh random nonce per seal) under a Worker secret, bound to the decision ID, its option keys, the hash of the rules and facts it was routed under, and a payload version. The page holds an opaque blob and posts it back with the chosen option to `/api/answer`, which checks the binding and the option before unsealing. Saved runs are imported only by the Worker, never shipped as static assets or in the page bundle or source maps. This prevents disclosure before the answer in ordinary use; a public repo and a stateless endpoint cannot make it an adversarially blind experiment, and the README says so.

**The answer lifecycle** (one state machine in `src/shared/lifecycle.ts`, unit-tested):

1. The displayed card is frozen with the rules/facts version it was routed under.
2. Jordan picks an option; the initial choice is recorded before anything is revealed.
3. Jordan gives a basis (voice or typing) or explicitly skips it. A decision asks for one; a check-in offers it.
4. `/api/answer` unseals. If the choice contradicts a standing fact or rule and the session's pushback ration is not spent, Bug Me pushes back quoting it; Jordan keeps the answer (and can say why it is an exception) or changes it. Both choices are recorded.
5. The answer is final; the guess is revealed. If the final answer went against a guess at or above the why threshold, and no basis was given yet, Bug Me asks "I'm curious: why?" (the basis is never asked for twice).
6. The basis goes to `/api/fact`, which proposes new guidance, a replacement for a named existing fact, or "no new guidance". Nothing is applied until Jordan keeps it (optionally edited).
7. Kept guidance re-routes the waiting decisions it may affect: the union of decisions sharing a topic tag with the source decision and the model's `may_affect`, validated against known waiting IDs, capped at a set number of calls. Affected cards stay visible, marked pending, then show old route, new route and the quoted cause.
8. The send-down instruction to the asking agent is shown, labeled simulated (no real agent receives it).

Undo on a settled decision reopens it for Jordan (it is not re-settled automatically). Marks are separate events in the record and never rewrite guidance by themselves. State carries a version; responses for a superseded version are ignored.

**Cost and abuse controls.**

- Responses are cached by a SHA-256 of the canonical request (model, settings, schema, prompt version, rules, facts, decision). The first view is a saved run of exactly these prompts, packaged with the Worker (not an edge-cache warm-up), so it costs nothing. The canonical demo path (the suggested "no" on the 6am flight, with its recorded reason) is packaged too, as a labeled **recorded example**.
- Saved output is replayed only on an exact match of the canonical request. For anything unmatched with no live model available, the visitor's work is kept, the affected cards show "couldn't evaluate this change", and the recorded example is offered, never silently substituted.
- Badges distinguish **live** (called just now), **cached** (an earlier live result for the identical request), **recorded example**, and **code**; "code adjusted this route" is a separate annotation.
- A daily spend counter in a Durable Object (UTC day): each live call atomically reserves a worst-case charge before the request and reconciles against the response's usage afterward; failures keep the reservation. Explicit `max_tokens`, a request timeout and no automatic retries.
- After a server-side Turnstile check, the Worker issues a short-lived signed session token that every paid endpoint requires, alongside a per-IP rate limit (Workers rate-limiting binding; approximate and per location, so the budget is the real backstop). Paid endpoints accept only known fixture decision IDs, and bound request bytes, rule and fact counts, and fan-out.
- A dedicated Anthropic API key in its own workspace with a workspace spend limit, set as a Worker secret. Saved-run generation and the eval run locally against a developer key and count against a local budget printed by the scripts.

**Honesty.** A banner says the persona and fleet are synthetic, routing is live Claude output, ordering is code, and the first view is a saved run. Each card carries a badge: live, saved or code. The README carries the same labels and states the evidence boundary above.

**Readiness eval.** `npm run eval` makes three fresh provider calls (bypassing the response cache) per condition on each designed fixture pair, with and without the deciding fact, against hand-written expected outcomes (route before and after, the permissible option, a supporting quote) plus unaffected controls; and one full reason-to-fact-to-re-route trial with an ordinary paraphrase of the recorded reason. The canonical flight path must behave as designed in all three attempts; everything else is reported per fixture, failures included, with latency and cost. Raw JSON goes in `results/`. These are designed demonstration checks, not an accuracy estimate.

**Acceptance has two statuses.** "Saved demonstration works" (no key needed) and "live demonstration works" (needs the key); a missing key never passes the second.

## Acceptance (each passes or fails)

```bash
npm ci && npm test        # unit: schema parse, route invariant, cache key, spend cap refuses past the cap, seal/unseal round trip, agenda ordering and reasons, why-loop state machine, pushback ration, fixture lint (18 categories, HR item present, every name in the synthetic allowlist)
npm run e2e               # Playwright vs wrangler dev + fake model: no guess in DOM or network before answering; 'no' on the 6am flight -> why prompt -> fact kept -> the 7:30am Berlin sync re-routes with a highlighted cause, an unrelated decision stays unchanged; edit a rule -> its decisions re-route quoting the new rule; settled list: undo and both marks recorded separately; explored options: both variants clickable; cap exhausted -> saved-run banner; phone width has no horizontal scroll
python3 scripts/scan.py   # secret and private-data patterns plus gitleaks over the tracked tree; fails if gitleaks cannot run; every data file lives under fixtures/ or results/
npm run eval              # live, costs money: designed pairs x3 with and without the fact; writes results/*.json; prints change counts
npm run live-check -- <url>   # deployed: page loads, /api/queue returns sealed cards, one live route returns a valid schema (if a key is set), spend counter moves, no API key text in any response
```

Plus a fresh clone passing `npm ci && npm test && npm run e2e`, and a Lighthouse accessibility pass at phone width in Chrome.

## Stages (one PR each, stacked)

Target: a working hosted loop by October 10, feature freeze October 12, stable October 13.

1. **Skeleton.** Fixtures with their contract, shared types and constants, agenda ordering, the route invariant, the fake model, a Worker serving the page and `/api/queue`, vitest, `scripts/scan.py` and the pre-push hook, CI on every branch, README skeleton. Deployed to a staging Worker.
2. **The core loop, end to end.** Sealing, `/api/answer`, `/api/fact`, the routing and fact prompts with schema and semantic validation, the cache, the spend reservation, the saved-run and recorded-example generator, the lifecycle state machine, re-routing with highlighted changes; Playwright on the flight → answer → why → kept fact → Berlin sync re-route path, against the fake model; a first small live eval.
3. **The rest of v1.** Rule editing, decisions made for you with undo and the marks, pushback, explored options with teach-back, the firefly glow, voice, the record with export and reset.
4. **Ship and harden.** Turnstile with session tokens and the rate limit, the full readiness eval, README completion, keyboard and screen-reader pass, Lighthouse at desktop and phone widths. Production on `bugme.weekly.org` only on David's explicit go.

Stretch, cut first if time slips (before anything in the core loop): voice-first presentation (typing always works), the glow's negative reactions, teach-back.

## Where the work happens

- Repo `~/dev/when-to-bug-me` (`dweekly/when-to-bug-me`), created private and made public by David after a look. Stages in worktrees `~/dev/when-to-bug-me-<stage>`, each with a PR.
- Private context lives in the separate working repo; nothing private flows into this one.

## Producers for every consumed state

| State the page shows | Produced by |
| --- | --- |
| Route, reasons, translation, sealed guess | `/api/route` (live or cached) or the saved run via `/api/queue` |
| Agenda order, project headers, minute estimates | `src/shared/agenda.ts` (code) |
| "Downgraded to check-in" note | `src/shared/route.ts` invariant (code) |
| Why prompt, pushback | `src/page/` state machine after `/api/answer` unseals the guess and conflicts |
| New standing fact, re-route list | `/api/fact` (live or cached) |
| Settled decisions | routed cards with `route == "settle"` after the invariant |
| Marks, answers, bases | the page's record in browser storage |
| Saved-run banner | `/api/*` responses whose `source` is `saved` because of cap, missing key or API failure |

## Plan review (Codex, 2026-10-09)

Folded in: earlier end-to-end loop and staging deploy; exact-match replay with distinct live / cached / recorded-example / code labels; hand-authored per-option bounds behind the settle invariant; an explicit answer lifecycle; context-bound sealing; reserve-before-call spending; session tokens after Turnstile; "no new guidance" and replacement from `/api/fact`; topic tags for re-routing; a stricter eval; a "You're Jordan this morning" framing; renaming the glow's negative signal to "accepted without a recorded basis". Its roadmap-level concerns (calibration, real execution and reversal, long-term guidance management, accounts, scheduling, production abuse resistance, richer voice and mascot) are in `ROADMAP.md`. Declined: counting distinct agents across shared descendants (the fixtures hold one flat count per decision, so there is nothing to double-count).

## Decisions held for David

- The persona (engineer, above) and the demo scope order were taken from the handoff's recommendations while he was away.
- The dedicated API key, making the repo public, and the production go.
