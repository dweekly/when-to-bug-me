# Stage 3: piles on Home, and a decision card you can answer at a glance

~~Home piles~~ (#13), ~~the decision card, answer types and always-on voice~~ (#14, #15): merged 2026-10-11. What remains is in `ROADMAP.md`.

## Why

David's review of the stage 2 app (2026-10-09):

- **Home should direct, not decorate.** The night sky of stars left the person to choose what to do. A chief of staff presents the work in piles by project and says which pile to take first, so someone not thinking hard can press one button and start.
- **Answering is not only A or B** (David, 2026-10-09). A confident person picks an option. Someone else agrees with conditions, proposes a different option, or needs a question answered before they can decide well. Each option should also show what it costs: money, time, or work for the agents.
- **The decision card should brief, then ask.** It opened on the question before the person knew what was being decided. Options looked like table cells, a separate Decide button (and "decide without a reason") added a step, the reason box read as mandatory, and the high-contrast "Not now" suggested punting was the expected next step.
- **Voice is the default way to say why.** The microphone stays on while the person moves through the queue, so a reason can be spoken at any moment without a button.

The intent: the person's time and attention go to the right item, in order, with the least friction between understanding a decision and making it, while Bug Me still collects reasons when they are offered. Another design that achieves that would also do.

Mockups David chose (version A of each) are kept in `docs/stage-3/`.

## What changes

**Home.** One large card recommends the first pile ("Start with Launch"): how many questions, about how long, why it is first (agents unblocked, compared with the other piles), its first three questions, and one Start button. The other piles are smaller cards below, each with its own Start. The numbered queue stays available under each pile. Ordering is the existing agenda code (projects by agents unblocked; within a project, decisions then quick checks, by agents unblocked then time waiting).

**Decision card.**
- Top: a short plain-language **briefing** of what is going on (a new routing field; the agent's raw `context` can be jargon, so it moves under "More context"), then why it is the person's (the code-adjusted explanation when code overruled Claude, otherwise `why_here`, with verified quotes), then the translated `headline` as the question.
- Options are large buttons, each with a short list of pros and cons, the agent's pick marked. The briefing visual stays below them. `in_your_terms` moves under "More context".
- Each option shows its **consequence** in one line (money, time, or work for the agents) when the decision's context supports one.
- **Clicking an option decides.** The flow enters an explicit pending phase bound to that card, choice and sealed guess, with an Undo bar for a few seconds (constant in `src/shared/constants.ts`). No answer call is made until it expires; leaving the card, a reset or a re-route of that card cancels it, keeping the draft. Then the answer is submitted as today (pushback, sealed guess, "I'm curious: why?" when surprised and no reason was given). Double submission is guarded.
- **Why is optional, to the side**, on quick checks and decisions alike, with what the microphone has heard so far, editable. What it holds when the pending phase ends goes with the answer; words added after the answer is done are saved against it as a late reason (the existing mechanism); a guidance request snapshots the text it was based on.
- **Other ways to answer**, quieter than the options:
  - *Yes, but…*: choose an option and add conditions. The conditions are sent with the decision (simulated) and are offered as guidance to keep, like a reason.
  - *Something else*: write a different option. It is sent as the decision (simulated) and recorded as such; Bug Me's sealed guess is opened against "neither".
  - *Ask a question*: Claude answers from what the agent provided (`/api/ask`, live or cached, labeled). If the answer is not in it, Claude says so plainly and the question goes back to the agent (simulated) while the decision is set aside with the question as its reason.
- **Not now** is a quiet text link, for "not today".

**Always-on voice, shown by the firefly.** The clay firefly sits in the top-right corner on every app view and is the listening control (David, 2026-10-09): resting while the microphone is off (click to turn it on; the browser asks for permission once), attentive while listening, brightening to pleased while it hears speech, with the words appearing beside it as they are understood before they land in the card's Why panel. Once on, it stays on across cards until turned off. The preference is separate from recognition sessions: each card gets a fresh session with its own generation id, so a late result from an earlier card is dropped; spoken text is kept apart from typed edits so one never overwrites the other. Listening shows only while a session is actually running; capture pauses on Home, between-project screens and closed cards and resumes on an answerable card; a permission denial stops retrying and says so. Speech goes to the Why panel of the card on screen. When the card changes, the transcript target changes with it; dictation never writes into a card that is not on screen. Beside the firefly, a line notes that the browser's speech service processes the audio.

**Briefing, pros, cons and consequences from Claude.** The routing call returns a two-sentence plain briefing and, for exactly the decision's option keys, up to two pros, up to two cons and an optional one-line consequence (cost, time, or work for the agents), alongside `in_your_terms`. Only facts in the decision may be used, and nothing may hint at Bug Me's guess; "the agent's pick" stays tied to `recommended`. The parser rejects missing, duplicate or unknown option keys; cards saved by an earlier visit without these fields still render. New `PROMPT_VERSION`; the recorded run is re-made and the eval re-run (both small spends).

**Tours** are re-scripted for click-to-decide: tours that show a reason given up front offer Jordan's recorded words before the committing click; "Start here" keeps its no-reason answer, pushback and "why?"; steps wait through the Undo window.

## Out of scope

Changes to routing decisions themselves, the pushback rules or sealing; the explainer page (its own branch, `stage/2f-explainer`); production deploy.

## Where

Worktree `~/dev/when-to-bug-me-queue`. Two PRs to `main`, each under the 2,000-line review limit: Home piles (`stage/3a-queue`), then the decision card, answer types, `/api/ask`, the prompt change and voice (`stage/3b-card`).

## Acceptance

```bash
npm run typecheck && npx vitest run      # route schema parses pros/cons; recorded run covers the new prompt
npx playwright test                       # all projects, plus:
#  - Home: exactly one recommended pile; its Start opens the first item of that pile; other piles' Start open theirs
#  - Card: context and why-it's-yours appear above the question; no Decide button exists
#  - Clicking an option shows Undo; Undo restores the choice state with nothing recorded; waiting past it records the answer
#  - A reason typed in the Why panel before clicking is sent with the answer; with no reason, a surprising answer still asks why
#  - Yes-but sends the conditions with the choice and offers them as guidance; Something else records the written option
#  - Ask a question (fake model): the answer shows, labeled; an unanswerable question sets the decision aside with the question
#  - Voice (fake SpeechRecognition): the firefly turns it on once; it follows the card on screen; heard words show beside the firefly; speech never lands in another card; off stops it
#  - Every tour still runs start to finish on the keyless recorded server
python3 scripts/scan.py
npm run record                            # before the recorded-run tests; re-makes route, fact and re-route calls for the new prompt version
npm run eval                              # exits non-zero unless every condition passes all three trials; capture stamped with PROMPT_VERSION
```

Then deploy staging from `main`, check the microphone once in a real browser there, and David runs the "Start here" tour.
