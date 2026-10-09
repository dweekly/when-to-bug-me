# Stage 2: focus, "not now", guided tours, and an explainer

fresh as of 2026-10-09 · the PRD and sequenced plan for the second round of prototype work. Forward-looking only; strike stages through as they merge.

## Why

David's review of the first build (2026-10-09):

- **The app breaks its own premise.** A product about focus shows one decision, the whole agenda, five side panels and the overnight story on one screen: a wall of text. The person should see an overview, then work one decision at a time.
- **The person needs a way to say "not now".** Sometimes they aren't sure, or need more information, or someone else's input. Bug Me should capture *why* they are setting a decision aside, so that when it comes back it arrives with what they needed.
- **Explaining the demo inside the demo is weak.** A separate page, visual and fun, should set the stage (Jordan, the fleet, the overnight queue, what Bug Me does), then let the visitor step into guided flows.
- **The 7:30am weekly invite.** When one of Jordan's standing preferences bears on something a rule would let Bug Me settle, Bug Me should check with Jordan and quote the preference ("only answer 1"). Claude does this two times in three today; it should be reliable.

A different design serves the intent equally well if a first-time visitor, in about two minutes with no narration, understands the world, works a decision in a focused view, sets one aside with a reason, and sees a reason become guidance.

## Design principles (David, 2026-10-09)

- **Simplicity and symbolism over text.** Every screen has one job. Copy is short and in Jordan's terms; anything explanatory moves to the explainer page or a disclosure.
- **One accent.** A night canvas, off-white text, a muted secondary tone, and a single warm accent (firefly yellow) reserved for the person's own agency: the option they pick, the microphone, the glow. No color-coded chips.
- **Routes are symbols:** ○ settled for you, ◐ a quick check, ● needs you.
- **Decision briefings are purpose-built visuals, not tables:** the flight as a morning timeline against the 10:00 start; the Berlin invite as two clocks (7:30 Pacific, 16:30 Berlin) recurring weekly; the outage chart rendered both ways; the API rename as the real payload with the field highlighted and the integrations that parse it; costs as side-by-side bars; the settings redesign as two clickable prototypes. Each decision's `visual` is data in the fixtures, drawn as SVG by `src/page/visuals.ts`; a decision without one falls back to its option cards.
- **Home's signature:** the fleet as a night sky, twenty agents in three constellations (one per project). Agents blocked on Jordan sit dim; an answer lights the agents it unblocks.

## Meetings are not cheap to undo (David, 2026-10-09)

Accepting a meeting for someone commits them to other people: declining later costs face with the organizer, and a meeting they didn't want costs their time. So accepting or scheduling a meeting is treated as **partly reversible** in the decisions' hand-authored bounds, with the cost named ("declining later is rude to the organizer"), and the settle invariant therefore never accepts one alone. The routing prompt says the same in words, so Claude's own reasoning matches the code. The card shows what undoing would cost whenever an option is not fully reversible.

## What the person sees

**Home** (`/app`). The overview, and nothing to decide on it:
- the firefly glow meter (the six mood-state SVGs from the brand work) and a Tours menu;
- *Overnight*: "28 questions came in. 5 settled for you, 10 quick check-ins, 13 decisions, about 30 minutes", with one **Start** button;
- *Your agenda*: one compact row per project in agenda order (counts, minutes, why it's first); expand a row to see its headlines; click one to open it;
- *Waiting for you to finish*, *Set aside* (with your reason), and a count of *Decisions made for you*;
- links to *Your rules and what Bug Me knows* and *The record*, each its own view.

**Focus** (`/app#/d/<id>`). One decision, full width, nothing else: a slim bar ("Launch · 2 of 10 · about 3 min · Home"), the card, and its actions (decide, or **Not now**). After answering, **Next** opens the next decision. A change of project gets a one-screen interstitial ("Launch is done. Next: Billing, 4 decisions, about 12 minutes"). Breaks are suggested only after a long stretch.

**Not now.** Asks "What would you need to decide this?", with quick choices (more information; someone else's input; not urgent yet; I'm not sure what I think) and a sentence by voice or typing. A reason is required: that is the point. The decision moves to *Set aside*; the asking agent is told, in its own terms, what to gather (simulated, from a template, no model call); the record keeps the reason. Reopening it shows "You set this aside: … The agent was asked to: …". A reasoned punt counts toward the glow.

**Other views.** *Decisions made for you* (undo and the two marks), *Rules and knowledge* (edit rules; standing facts; the "how to work with me" note), *The record* (export, start over).

**Tours.** Six guided flows over the real app, each about a minute, all runnable with no API key on the recorded Claude run: say no and say why (the flight); your rule, quoted (the API rename); pushback from your own record; see it before you choose (the settings prototypes); lost in translation (T-19); what Bug Me decided for you; plus a short **set it aside** tour. Each starts from a fresh morning (an in-page confirmation if there is progress), uses Jordan's recorded words when live calls are off (offered and labeled), and can be left at any step. Engine: **driver.js 1.9.0** (MIT, about 7.5 kB gzipped; Shepherd.js and intro.js need paid licenses for commercial use). The visitor clicks the real buttons; steps wait for async states; the tour re-finds its target after every re-render; reduced motion turns animation off; an `aria-live` region announces each step; Escape leaves.

**The explainer** (`/`). Scroll-told, firefly as narrator, in the dusk palette: the overnight hero; meet Jordan (twenty agents in three project lanes); the overnight sort into three bins with real counts and headlines from `/api/queue`; why it asks why (a small looping diagram); *Step inside* (the tour cards); *What's real here* (live, recorded, code; the evidence boundary). CSS plus IntersectionObserver, a static end state for every motion under reduced motion, no horizontal scroll at 320px, full OpenGraph and JSON-LD.

## How it changes the code

- `src/page/main.ts` (1,200 lines) is split into modules with no behavior change first: `state.ts` (state, storage, record), `api.ts`, `card.ts` (the decision card and its lifecycle), and one module per view, with a small hash router. Then the new views are built on that.
- `buildAgenda` gains the set-aside ids (excluded from sections, listed separately); the lifecycle gains a `punt` event; `S.punts` keeps each reason.
- The routing prompt states the principle: *never settle alone when a standing fact bears on the choice; bring it as a quick check-in and quote the fact.* `PROMPT_VERSION` is bumped and the run re-recorded; two more scripted examples (settings, T-19) are recorded for the tours.
- The eval's Berlin expectations change: before the flight reason, a check-in quoting the summary preference, guess on accept; after it, a check-in, guess on decline, quoting the new fact.
- `public/index.html` becomes the explainer; the app moves to `public/app.html` (`git mv`).

## Contracts (from the plan review, Codex, 2026-10-09)

- **Changed framing is surfaced, not just changed routes.** After guidance is kept, every re-checked decision whose route *or* quoted fact changed is listed on the answered card ("The 7:30am Berlin invite now accounts for school drop-off"), with a link; its new guess stays sealed.
- **Precedence.** If a decision would otherwise be eligible to settle, a relevant standing fact requires at least a check-in; anything that needs a substantive decision stays one. Code backs this: the settle invariant also refuses when the model quoted a verified standing fact. Cards show the verified rule *and* the verified fact when both exist. The eval's 3/3 is the fixture release gate, not a reliability claim.
- **"Not now".** Allowed before an answer is final (including at pushback); not once it is final (those stay under *Waiting for you to finish*). It stores the category, the required sentence, the time, and the exact simulated instruction to the agent; the decision stays unanswered with no guess revealed; it stays set aside through re-routing and is never settled automatically; it returns only through an explicit *Resume*; its history is kept after resuming or answering. Each category tailors the prompt ("What information is missing?", "Whose input, and on what?", "When should it come back?", "What's making it hard to call?"). The prototype says plainly that nothing was gathered: the decision reopens with the reason and the request, not with new evidence.
- **Next keeps you in a project.** A focus session finishes the current project's active items before moving to the next project in agenda order; set-aside and unfinished items don't block "done", and the interstitial says "Launch's active queue is clear" when some remain.
- **One estimate function** (`src/shared/agenda.ts`) for Home, sections, interstitials and the explainer, from effective routes after the code invariant; overnight totals and remaining work are shown separately.
- **Tours are scripts.** `src/shared/tours.ts` is the one catalog (stable ids, titles, steps, and for each step the exact choice, reason and guidance action). `scripts/record.ts` records every model call the scripts make, in order from a fresh morning; a unit test regenerates those requests and fails if any is missing. If a visitor leaves the script (a different choice or their own words with live calls off), the tour says so and offers to continue freely.
- **The recorded test project** runs its own Worker with no fake flag and no key, a throwaway seal key and isolated state; it asserts `mode === "recorded"` and recorded provenance, at 390px, 320px and desktop, and runs in CI.
- **Views and navigation.** Home's lists never depend on the last focused card. Direct links, reload, Back/Forward, unknown or finished ids, and focus restoration are defined and tested; new state gets migration defaults.
- **Tour steps** advance only when the expected app state is reached, with a bounded wait that offers retry or exit and never silently skips; Back is instructional and never replays an action; the settings prototypes are highlighted as whole frames; Escape works even with focus inside a prototype.
- **The recommended path.** One "Start here" tour of about two minutes: the overview, the flight loop, then setting another decision aside. David runs it without narration, plus one other tour. Keyboard-only runs cover focus, Not now, confirmations and tour exit.
- **Assets and schedule.** The six mood SVGs are copied from the brand work's `firefly-mood-states.zip` (from the private proposal repo) into `public/firefly/`; mapping: nothing waiting → resting; default → attentive; glow at or above a set level → pleased, and at a higher level → delighted; a decision accepted with no recorded reason → disappointed; "shouldn't have come to me" → sheepish. Schedule: October 10, stages 2 and 3; October 11, tours and the explainer; October 12, stabilization, staging, hosted smoke tests and David's run; production stays out of scope.
- **Smaller:** `/app` is wired in stage 2 with `/` temporarily redirecting to it; separate page bundles with the tour CSS linked explicitly; a compact "Synthetic prototype · recorded Claude" indicator stays in the app; glow accounting counts reasoned punts once and never says "every agent is unblocked" when work is only set aside; the explainer renders its story without `/api/queue` and shows "counts unavailable" rather than invented numbers; README, ROADMAP and BUILD-PLAN drop the "Berlin starts settled" story in the same change.

Roadmap, not this effort: real gathering and automatic return for set-aside decisions; general policy-conflict resolution; scheduling beyond one morning; accounts and durable records; evidence that the glow helps; real execution and reversal.

## Acceptance (each passes or fails)

```bash
npm run typecheck && npm test        # unit: agenda excludes set-aside ids; punt needs a reason; mood mapping; tour steps reference real views and ids; the recording covers every tour's model calls
npm run e2e                           # fake model, desktop and phone: home shows no decision card; focus shows exactly one; Not now without a reason is refused; with one, the decision appears under Set aside with the reason and reopens with it; Next and the project interstitial; all stage 1 regression tests still pass against the new views
npm run e2e -- --project=recorded     # NO key, NO fake: each tour runs start to finish at both widths on the recorded run, with no "couldn't evaluate" on its path; the explainer's counts equal /api/queue; every tour card opens the right flow
npm run eval                          # Berlin: check-in quoting the summary preference before, decline-leaning and quoting the new fact after, 3/3 each
python3 scripts/scan.py && python3 scripts/scan.py --history
```

Plus a Lighthouse accessibility score of at least 95 for `/` and `/app` at phone width, and David runs two tours himself.

## Stages (one PR each, stacked on stage 1)

1. **Split the page into modules**, no behavior change; every existing test passes unchanged.
2. **Home, focus and "Not now"** in the new visual language (night canvas, one accent, route glyphs, the fleet sky), the mood-state firefly; the 7:30am and meeting principles and the re-recording; e2e for the new views.
3. **Decision briefings as visuals**: `visual` data in the fixtures and the SVG renderers (timeline, two clocks, before/after chart, payload diff, cost bars), at both widths, each with a text equivalent for screen readers.
4. **Tours** with driver.js; the extra recorded examples; the recorded-mode Playwright project.
5. **The explainer** landing page; README update.

## Where the work happens

Worktree `~/dev/when-to-bug-me-stage2`, branches `stage/2a-…` upward, stacked on `stage/1e-docs`. Stage 1 lands first through one integration review of the whole stack (David, 2026-10-09).

## Out of scope

New personas; audio or video; analytics; a model call for "not now" (a template is enough until it isn't); production deploy.
