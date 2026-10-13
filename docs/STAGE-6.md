# Stage 6: the decision as a conversation

## Why

David's review of stage 5 on staging (2026-10-12):

- **A decision is a conversation Bug Me starts.** It says what needs deciding, the context, and why it came to Jordan rather than settling it. Then it opens the floor: Jordan can ask questions, pick, give the why and any nuance, say how urgent it really was or whether it should have been obvious, or reject the question and its framing outright (a "mu"). Bug Me should nudge, and be a little persistent, until it has what it needs, while keeping in mind how long this topic has taken and not rabbit-holing on minutiae. A bare click on the recommendation with no context is a small failure; demanding essays is a bigger one. Chat's useful part is a top-to-bottom, turn-taking narrative.
- **The card has no room for back and forth.** One text box and one Send leave nowhere for a reply.
- **The microphone is in the wrong place.** It sits on the header firefly, but the words go into the card's text box.
- **"More context" should come before the conversation starts**, not under it.
- **"Not now" should read "Skip"**, and the default forward action belongs at the bottom right, not the bottom left.
- **"Start with Launch" and "Start Launch" don't say what they mean.**
- **Decided for you repeats itself.** Every row has its own "Why" saying it was settled because a rule allowed it. The yellow rings mean nothing to a reader, and the actions (Undo, "You should have asked me", "Right to decide, wrong call") are long text buttons. David: plain English, short and expressive, icons, no codes like "R2" that need a decoder ring, and no repetition.

David's decisions (2026-10-12): the full agent-led conversation (not only a re-laid-out card); the microphone only in the text box; keep the project piles on Home with clearer words; Decided for you redesigned to his principles, shown as a still mock before it is built.

The intent: every question Jordan sees is resolved through a short conversation that captures the choice, the why, the conditions, and Jordan's feedback on the question itself, at the highest useful bitrate for the least of Jordan's time. Another design that captures the same things with less on screen would also do.

## What changes

### 1. The decision thread

The card becomes a thread, read top to bottom:

1. **Bug Me's opening.** The briefing, why it came to Jordan (the routed card's reason, in plain words), "More context" (folded), the question, and the options in columns, as the stage 4 card lays them out. Nothing here calls the model. The routed card is captured into the flow when the thread starts, and that snapshot is used for every turn and for the answer.
2. **The conversation.** Jordan's turns are right-aligned, Bug Me's left with the small firefly; each Bug Me turn carries its source label (live, recorded, stand-in). A composer sits under the last turn: a text box with the microphone inside it. Clicking an option picks it (the column lights); the pick travels with the next turn.
3. **The actions row**, under the composer: "Skip" at the far left, the primary action at the right. The primary action is the decision itself once Bug Me has read it back: "Keep user_id", "Take the 9:40am flight". Until then it is "Send". For a listed option the label is the option's label (no model call); for "other" and "reject" it is the short `action` phrase from the conversation.

#### The turn contract

A turn of Jordan's is `{ text, pick? }`: the words (typed or spoken; may be empty when there is a pick) and the option clicked since the last turn. A pick is stored in the transcript as an action, never as an invented quote. Words in the same turn that say otherwise override the pick ("actually, the other one").

`/api/converse` takes the decision id, the captured card's content (never `sealed` or `source`), Jordan's rules and facts, the transcript, and the ledger. These fields, and only these, are the model input and the recording key, so replay does not depend on timing, seals or labels. No elapsed time is sent; pacing is the question cap below. Claude returns, under a JSON schema:

- `reply`: Bug Me's next turn, at most 300 characters and at most one question;
- `ledger`: the **current interpretation** of everything Jordan has said, replacing the previous one (corrections replace superseded choices, reasons and conditions; the transcript itself never changes):
  - `choice`: an option key, `"other"`, `"reject"` (Jordan rejects the question or its framing), or `"none"`;
  - `choice_quote`: the words that made the choice, when it came from words rather than a click;
  - `course`: Jordan's words for "other" or "reject" (required, verified and non-empty for those two; otherwise the choice falls back to `"none"`);
  - `action`: for "other" or "reject", an imperative of at most five words for the button;
  - `why`, `conditions`: quotes;
  - `questions`: Jordan's questions, each with the answer from the agent's material, or `null` when the material doesn't say;
  - `feedback`: quotes about the question itself, each tagged `priority` (more or less urgent than framed) or `routing` (should or shouldn't have come to Jordan);
  - `no_more_questions`: true when Jordan has asked Bug Me to stop asking ("just do it");
- `next`: `"ask"`, `"confirm"`, or `"close"`.

Every quote carries the index of the turn it came from and must be a literal substring of that turn (`findQuote`); unverified quotes are dropped. Verified quotes are drawn as marks on Jordan's sent turns: the stage 4 styles for choice, why, but and ask, plus a wavy underline for feedback.

#### Who decides what happens next

One shared function, `advance(transcript, ledger, modelResponse)` in `src/shared/converse.ts`, decides both the next state and the visible reply. The model proposes; code disposes:

- **The question cap.** Bug Me asks at most two elicitation questions per decision (counted from Bug Me's turns actually shown). Pushback, the guess reveal and the guidance offer don't count. Jordan always gets to answer the second question; after that answer, `advance` forces a read-back.
- **No more questions.** With `no_more_questions`, the reply goes straight to a read-back.
- **The read-back always comes before close.** A model `"close"` without a read-back the person confirmed becomes `"confirm"`. When code overrides the model, it writes the read-back itself from the verified ledger (a fixed template per outcome, below), so the visible reply never asks a question code has just ruled out.
- **Confirmation is bound to the ledger revision Jordan saw.** Any new words or another click is a new turn and invalidates it.

**Terminal read-backs**, one per outcome:

| Outcome | Read-back | Primary button |
| --- | --- | --- |
| A listed option | "So: {label}, {conditions}. Right?" | the option's label |
| Other | "So: not either option. {course}. Right?" | `action` |
| Reject | "So you're rejecting the question: {course}. I'll tell the agent. Right?" | `action` |
| Questions the material can't answer, no choice | "I'll ask the agent: {questions}, and set this aside." | "Ask the agent" |
| No choice, no open questions | "Want to set this aside for now?" | "Skip" (opens the Skip panel) |

**Skip** keeps the existing panel (a kind of reason and a sentence). Saying "skip it" with a clear choice is `no_more_questions`; without one it is the last row of the table.

#### Close

When Jordan confirms, the ledger feeds the existing path:

- **A listed option**: `answer` → pushback → `finalize` → `propose`. The reason is the `why` quotes joined; the conditions are the `conditions` quotes; the narration is all of Jordan's turns.
- **The why backstop** ("I'm curious: why?") is suppressed when Jordan said `no_more_questions`. (Until stage 6f it was also suppressed when the conversation had already asked; 6f's reveal of the agent's pick made a second, pointed ask worthwhile. See docs/STAGE-6F.md.)
- **Feedback** is a reason to propose standing guidance (a fact, via `/api/fact`), even when Jordan agreed with the recommendation, so "you shouldn't have asked me this" can be remembered.
- **Other** goes through `chooseOther` with `course`, and **reject** through a new `rejected` outcome. Both can propose guidance when there is feedback or a why. `/api/answer` stays option-only. `/api/fact` gains an `outcome` field (`"option" | "other" | "rejected"`) with the course in Jordan's words, so neither is ever mapped onto a listed option. `Answer` gets one `outcome` field, used by the flow, the record and export, the closed card, and the agenda (rejected and other count as resolved).
- **Ask the agent** goes through `sendQuestionToAgent`, as today.

#### Limits and cost

Each turn of Jordan's is at most 600 characters (`MAX_REASON_CHARS`). A thread holds at most 6 of Jordan's turns and 2,400 characters of them; after that the composer offers only the read-back. The fact evidence (the why, conditions and feedback quotes) is capped at 900 characters: whole quotes, in order, never cut mid-quote. `/api/fact`'s limit rises to match. The spend reservation per call is recalculated for the largest converse prompt. Each Bug Me reply is one call at effort low, about $0.02–0.04, usually two or three per decision; the daily cap stays.

#### Persistence and re-routes

The transcript, every Bug Me reply, and the ledger are saved in the flow while the thread is open and in the `Answer` (or the set-aside record) once it closes. They are included in export, and a closed thread re-opens read-only. Storage moves to `bugme.state.v4`, and older mornings start fresh, as in stage 5. A reload restores the thread, the question count, `no_more_questions`, and any pending read-back. A decision with an open thread (at least one turn) is left out of re-routes, so it can't move into Decided for you under Jordan. The stage 4 protections stay for every turn: a stale response is dropped, and a second click does nothing. The voice target key includes the turn number, so late words can't land in the next turn; `drainVoice` runs before each send.

#### Focus and announcements

Only the new Bug Me turn is announced (a polite live region). A draft typed while Bug Me is replying is kept. The thread scrolls to the new turn only when Jordan is already near the bottom. Focus stays in the composer. During pushback and guidance, the composer is replaced by those turns' buttons (and the guidance text box).

#### What goes

The as-you-type parse (`/api/parse` from the page) and the per-quote `/api/ask` calls go: the conversation does both jobs once per turn. The endpoints and their recordings stay for the eval and history until a later cleanup (ROADMAP).

#### Without a key

- **The stand-in.** The fake model gets a deterministic, stateful `fakeConverse`, clearly labeled as a stand-in:
  - a bare option label gets "Why that one?";
  - a turn with "because"/"since" and a resolvable outcome gets the read-back;
  - "?" gets "I don't know; I'll ask the agent";
  - "yes"/"right"/"send it" closes, but only after a read-back;
  - "neither, …" with a course is "other"; "wrong question"/"why are we … at all" is "reject".
- **Recorded mode** replays on the projection above. Each tour decision gets a scripted conversation (two or three of Jordan's turns), shared by the recorder and the tours in `src/shared/examples.ts`. `scripts/record.ts`:
  - plays each script against live Claude, advancing on the response after `advance`, exactly as the browser receives it;
  - derives the fact and re-route calls that follow;
  - re-validates entries already recorded;
  - fails when an outcome differs from the script's expectation.
  
  The SDK pushback tour gets its own script. Tours offer "Use Jordan's words" per turn on live servers too, since an exact replay costs nothing. That also fixes today's bug, where the tour text says "Or use Jordan's words" on a live server that hides the button.

### 1b. An emoji and a short title for every decision

David (2026-10-12): a fast, cheap classifier gives each decision an emoji and a short title. When the morning is routed, Claude Haiku 5.5 (`claude-haiku-5-5`) returns, per decision:
- `emoji`: one;
- `title`: at most six words ("Rename the v2 user field");
- `done`: for settled items, at most six words in the past tense ("Deleted 41 merged branches").

These are recorded like every other call, and are fixture-checked in tests (one emoji, word limits). They are used on Home's piles and queue, the thread header, and Decided for you's rows. They never feed routing.

### 2. Smaller fixes, from the same review

- "Not now" → "Skip", everywhere: buttons, tours, tests, docs.
- The primary action sits at the bottom right in every action row: card, proposal ("Don't keep" left, "Keep it" right), pushback, Home's start, between-projects.
- The microphone moves into the composer; the header firefly is only the glow meter.
- Home keeps the piles. The eyebrow becomes "Suggested first", the pile reads "Launch project · 5 questions · about 11 min", and the button reads "Begin Launch". "1 decisions, 1 quick checks" is pluralized properly.
- Option hover is visibly lighter than a pick (today they look the same).
- The heading focused after a route change shows no ring for mouse users (`:focus-visible`).

### 3. Decided for you

A still mock first (`docs/stage-6/decided-mockup.html`, with a screenshot). It follows David's principles:
- one plain sentence at the top, said once: what these are and why Bug Me could decide them;
- items grouped by kind of work, each group with an icon. The kind is a hand-authored `work` field on each fixture (branches, updates, formatting, flaky tests), since the category is "Code: housekeeping" for nearly all of them;
- one short line per item: Haiku's `done` line;
- three icon buttons on every row, labeled Undo, Ask!, Disagree, with accessible names and 44px touch targets. They wrap on phones rather than losing their labels;
- no rings, no codes, no per-item Why. The rule that allowed an item shows only on request, in plain words, and a group shows a shared rule only when it applies to every item.

It is built only after David approves the mock.

## Where the work happens

PRs under the review size cap (2,000 changed lines, not counting `fixtures/captures/*.json` and lockfiles):
- `stage/6a-fixes`: section 2. Section 3 follows in its own PR once the mock is approved, if 6a would go over the cap.
- `stage/6b-converse`: the endpoint, prompt, schema, `advance`, `fakeConverse`, the request projection, the shared scripts, the recorder, the eval, Haiku titles, and unit tests including the close-path mapping.
- `stage/6c-thread`: the thread UI, the close path, persistence, tours re-scripted, README and explainer copy, e2e. Based on 6a and 6b.

## Graduation gates

```bash
npm run typecheck && npm test        # converse: schema per decision, quote verification by turn, advance (cap, forced read-back with its template, premature close, click-only turns, no-choice exhaustion, confirmation invalidated by a new turn), close-path mapping (option, other, reject, ask-the-agent, set aside), the why backstop's flags, fakeConverse; titles: one emoji, word limits
npm run e2e                          # desktop, phone and 320px (the narrow project gains stage 6) on the stand-in; every tour on the keyless recorded server at desktop and phone, and on a live-configured server where Jordan's scripted turns make no paid call; click-only send; opt-out then a surprising choice; feedback on a recommended answer reaching guidance; a correction removing a condition; other and reject through record, reload and export
npm run eval:converse                # 8 scripted conversations x 3 live trials, expectations written first (below)
python3 scripts/scan.py
```

`eval:converse` cases, each judged per turn:
1. A bare pick: `next` is "ask", and the reply asks why.
2. A full narration (pick, why, a condition): `next` is "confirm", and the read-back names the pick and the condition.
3. A question the context answers: answered from the material; the choice stays "none".
4. A question the context can't answer: `answer` is null, and the reply says so.
5. "Just do it, the 9:40": straight to "confirm", with no why question.
6. A mu ("neither; why are we renaming in v2 at all?"): `choice` is "reject", and `course` quotes it.
7. Routing feedback ("this shouldn't have come to me"): captured as `routing` feedback.
8. A correction after the read-back: the ledger changes, and a new read-back follows.

On every turn: at most one question mark in the reply, and no quote in the raw model output that fails verification (checked before sanitizing, so the check can fail). Each trial is a sequential conversation, independent of the other trials.

Plus: Lighthouse accessibility at 100 on a thread at phone width; screenshots of a three-turn thread at 1280 and 390 wide, checked by eye; David's real-microphone check on staging.

## As built: stage 6b (the server side)

Where the build differs from the plan above, and why:

- **The ledger isn't sent back.** Each turn sends the transcript only; Claude re-reads it and returns the whole current ledger. That makes the request smaller, and nothing from an earlier answer can leak into a recording key.
- **The card the conversation sees is its route and `why_here`.** That is enough for Bug Me to talk about why it came to Jordan. It is the whole projection: `sealed` and `source` are dropped (`parseConverseRequest`, tested).
- **Confirming with the button makes no call.** Only a typed "yes" goes to the model. Its "close" stands only when the turn just agrees with the read-back before it: the same decision (each read-back carries `heard`, a fingerprint of the choice, course and conditions it read back, which the page stores and sends back), no click, and no new question. "Yes, but only if…", "yes, without the docs note" or a yes with a different click gets a fresh read-back (Codex review of #26, two passes).
- **`whyAsked`** (removed in stage 6f) meant "Bug Me asked anything": any elicitation question silenced the backstop.
- **The scripts are `CONVERSATIONS` in `src/shared/examples.ts`,** separate from `EXAMPLES`, which the stage 4 page still uses until 6c.
- **Titles: 39 of 40 recorded.** However often it is asked, Haiku titles `dockerfile-format` in seven words ("Trim whitespace and sort Dockerfile package lists"). The limit stays at six, and that card shows its headline instead; the test names the exception.
- **The spend reservation is unchanged.** The largest conversation prompt is under 24,000 characters (about 8k tokens), the figure the reservation was set for.
- **What the first recording caught:** a read-back that added a detail Jordan never said; a follow-up question after Jordan had said everything; Bug Me raising a conflict with Jordan's rule before the pushback step; and two reason quotes run together. Prompt 2026-10-12.2 and the quote joining fix all four. The recordings were redone from scratch.
- **Eval:** `npm run eval:converse` passes 8/8 conversations, 24/24 trials, at 1.8–6.9 s per turn and $0.50 a run (`results/captures/eval-converse-2026-10-12T16-11-33-400Z.json`). One check was corrected after the first run, and the script says so: the correction case checked that no condition mentioned "docs", but a trial rightly kept the correction itself ("Actually, skip the docs note.") as the new condition; it now checks that the turn-0 condition is gone.

## As built: stage 6c (the page)

- **The thread** replaces the think-out-loud box (`src/page/card.ts` `threadArea`/`paintThread`, `src/page/actions.ts` `sendTurn`/`confirmThread`). The composer is mounted once per flow, so typing keeps focus while replies arrive; Enter sends, Shift+Enter is a new line. Marks on Jordan's turns come from the latest ledger, by turn. Each Bug Me turn shows its source label unless it was live.
- **The close path** is the existing one, with the thread's inputs: `finalize` passes `noMoreQuestions` (and, since 6f, the agent's pick) to `shouldAskWhy`, and feedback is a reason to propose guidance; other and rejected outcomes go through `chooseOutside` and can propose guidance with `outcome` and `course`. The answer keeps `outcome` and the whole `thread`; a closed card re-opens with it, read-only.
- **Re-routes skip a decision with an open conversation** (`reroutableIds`, and a filter in `reroute`), so a card can't move into Decided for you mid-talk.
- **A failed or interrupted turn** keeps Jordan's words in the thread; the button becomes "Send again" and asks for the reply without adding a turn.
- **Tours** talk through each decision with the scripted turns (`say`/`decide` steps); the tour offers the next scripted turn for wherever the thread is. A tour step waits for Bug Me's real reply, never its typing dots.
- **Tests.** `tests/e2e/stage6.spec.ts` replaces stage 4's spec. The "I'm curious: why?" backstop is now reachable only when Bug Me reads back without asking (a live model may; the stand-in always asks), so its tests use `decideQuietly`, which stubs one `/api/converse` reply as an immediate read-back and runs everything after it for real.

## Plan review

Codex reviewed this plan once (2026-10-12). Folded in above: the turn contract with clicks, `advance` owning both the state and the reply, terminal read-backs, the backstop flags, Skip versus "skip it", turn-referenced quotes and the ledger as current interpretation, feedback as a reason for guidance, the outcome field for other and reject, limits, the request projection for replay, persistence, the card snapshot and re-route protection, focus rules, the extra gates, the mock's phone and label fixes, and hand-authored work kinds. Its roadmap items (the full lifecycle for "other", real agent delivery, conversation quality beyond the designed cases, durable server-side threads, adaptive ordering and streaming) are in `ROADMAP.md`.

## Out of scope

- Bug Me choosing which decision to raise next from what was just said (the "next best thing" ordering). The piles stay; it goes on the roadmap.
- Streaming Bug Me's replies token by token.
- Changing the route, fact or answer prompts, or the pushback, guess and guidance rules.
- Removing `/api/parse` and `/api/ask` from the Worker.
- A production deploy (David's go).
