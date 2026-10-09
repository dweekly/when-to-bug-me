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

**Code-enforced invariant.** Bug Me settles alone only what is reversible, cheap, and cleared by a written rule. If the model says "settle" without all three, code downgrades the route to a check-in and says so on the card (labeled code).

**Hidden guesses, structurally.** The Worker seals the guess, the conflicts and the send-down text with AES-GCM under a Worker secret before returning a routed card; the page holds an opaque blob and posts it back with the answer to `/api/answer`, which unseals it. The guess is never in the DOM, page memory or network responses before the answer.

**Cost and abuse controls.**

- Responses are cached by a SHA-256 of the full request (model, settings, prompt). The first view is a saved run of exactly these prompts, so it costs nothing; the canonical demo path (the suggested "no") is in the saved run too.
- A daily spend counter in a Durable Object, capped at a set dollar figure per day, priced from the response's own usage.
- A per-IP rate limit (Workers rate-limiting binding), Turnstile before the first live call, and input length caps.
- When the cap is hit, the key is absent, or the API fails or declines, the page falls back to the saved run with a banner saying so.
- A dedicated Anthropic API key with its own spend limit, set as a Worker secret. Until it exists, the deployed demo runs entirely on the saved run.

**Honesty.** A banner says the persona and fleet are synthetic, routing is live Claude output, ordering is code, and the first view is a saved run. Each card carries a badge: live, saved or code. The README carries the same labels and states the evidence boundary above.

**Readiness eval.** `npm run eval` runs the real model three times on each designed fixture pair, with and without the deciding fact, and records whether the route changes as designed. Raw JSON goes in `results/`; the README reports the counts.

## Acceptance (each passes or fails)

```bash
npm ci && npm test        # unit: schema parse, route invariant, cache key, spend cap refuses past the cap, seal/unseal round trip, agenda ordering and reasons, why-loop state machine, pushback ration, fixture lint (18 categories, HR item present, every name in the synthetic allowlist)
npm run e2e               # Playwright vs wrangler dev + fake model: no guess in DOM or network before answering; 'no' on the 6am flight -> why prompt -> fact shown -> the early kickoff decision re-routes with a highlighted cause; edit a rule -> its decisions re-route quoting the new rule; settled list: undo and both marks recorded separately; explored options: both variants clickable; cap exhausted -> saved-run banner; phone width has no horizontal scroll
python3 scripts/scan.py   # secret and private-data patterns plus gitleaks over the tracked tree; fails if gitleaks cannot run; every data file lives under fixtures/ or results/
npm run eval              # live, costs money: designed pairs x3 with and without the fact; writes results/*.json; prints change counts
npm run live-check -- <url>   # deployed: page loads, /api/queue returns sealed cards, one live route returns a valid schema (if a key is set), spend counter moves, no API key text in any response
```

Plus a fresh clone passing `npm ci && npm test && npm run e2e`, and a Lighthouse accessibility pass at phone width in Chrome.

## Stages (one PR each, stacked)

1. **Skeleton.** Repo, fixtures, shared types and constants, the static agenda page with code ordering and the saved-run shape, vitest, `scripts/scan.py` and the pre-push hook, CI on every branch, README skeleton. No model calls.
2. **Routing.** `/api/queue`, `/api/route`, the routing prompt, schema and parser, the invariant, sealing, the cache, the spend counter, the saved-run generator, and a fake model for tests.
3. **Why-loop, rules, and the rest of v1.** `/api/answer`, `/api/fact`, re-routing with highlighted changes, rule editing, decisions made for you, pushback, explored options, the firefly glow, voice; Playwright end to end.
4. **Ship.** Staging deploy (no permission needed, from `main`), Turnstile and the rate limit, the readiness eval, README completion, Lighthouse and accessibility at desktop and phone widths. Production on `bugme.weekly.org` only on David's explicit go.

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

## Decisions held for David

- The persona (engineer, above) and the demo scope order were taken from the handoff's recommendations while he was away.
- The dedicated API key, making the repo public, and the production go.
