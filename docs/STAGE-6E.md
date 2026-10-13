# Stage 6e: "Huh?"

## Why

Sometimes a question still doesn't make sense after Bug Me has translated it. David (2026-10-12): one kind of feedback on a question is "the question as posed doesn't make any sense to me, can you retry in plainer, simpler terms?" A scratching-head "Huh?" should get Bug Me to "immediately turn around and re-present in plain English with better context". It is also feedback on Bug Me itself: Bug Me's job is translating the fleet's questions for one person, and a "Huh?" means it didn't do that well. It is different from "the agent asked badly" (routing) or "this wasn't urgent" (priority).

The thread exists so the person can talk back to Bug Me. Confusion is the cheapest kind of talking back, so it gets one press, the way a choice gets one click.

## What changes

### 1. A "Huh?" button

- **🤔 Huh?** sits in two places:
  - under the card's question, until the thread has a Bug Me turn;
  - after that, on Bug Me's latest turn.
- It is never shown on older turns. It always refers to the last thing Bug Me showed: the card (briefing, question and options), or Bug Me's latest turn.
- One press sends a turn at once. There is no composer and no Send step.
- The press becomes a Jordan turn `{ who: "jordan", text: "", huh: true }`.
  - It is shown in the thread as a small "🤔 Huh?" chip on Jordan's side.
  - Anything typed but not yet sent stays in the box.
- The button is disabled while a turn is in flight or the last turn is unanswered, the same as Send.
- After two presses in one thread it disappears. The person can still type, skip or decide.

### 2. Bug Me re-presents the question

- `Next` gains `"explain"`. An explain turn is not an elicitation question, so it never counts toward `MAX_CONVERSE_QUESTIONS`.
- **Prompt.** When the newest turn is a Huh?, or typed confusion ("I don't follow", "what does that mean?"), Bug Me re-presents what was unclear in plain English:
  - what is going on;
  - what each option would actually do, in everyday terms;
  - any term the person might not know, defined;
  - the question again, asked simply.
- **Content limits.** It uses only the agent's material, adds nothing the material doesn't say, and doesn't lean toward an option.
- **Length.** Up to `MAX_EXPLAIN_CHARS = 700`, longer than a normal turn because it carries context.
- **The ledger doesn't change.** A Huh? has no words, so the model's reading of the thread should come back the same.
- **`advance` rules:**
  - If the newest turn is a Huh?, the result is `explain` whatever the model said, using the model's reply (clipped to the limit).
  - If the model returns an empty reply on a Huh?, code writes the stand-in explanation (below).
  - The model may return `explain` without a press only when its ledger records typed confusion in the newest turn (feedback kind `"unclear"`). Otherwise `explain` becomes an `ask` under the usual rules: the question cap, "stop asking" and the thread limit.
- **Limits.** Huh? turns don't count toward `MAX_CONVERSE_TURNS`. They have their own cap, `MAX_HUH = 2`, enforced in `parseConverseRequest` and on the page.
- **Reading back after an explanation.** An explanation never lights the decision button. If the person then says "yes", Bug Me reads back first, because the last turn wasn't a read-back. This needs no new code: `agreesOnly` already requires the last Bug Me turn to be a read-back.
- **Without a key.** The stand-in (`fakeConverse`) answers a Huh? deterministically and is labelled "stand-in" as usual: "In plain terms: {first two sentences of the context} The choice: {A label} or {B label}."

### 3. Recorded as translation feedback on Bug Me

- Feedback kind `"unclear"` is added for typed confusion. Its quote is marked like other feedback.
- It does **not** set `hasFeedback`, and it doesn't go into `evidence`. It says nothing about the person's preferences, so it must not trigger a guidance proposal about the decision.
- The answer log gains `unclear: n`: the number of Huh? presses plus `unclear` feedback quotes in the thread. The thread itself is already logged with the answer, so each miss can be traced to the turn it followed.
- This is Bug Me's own scorecard. Turning it into anything (guidance for Bug Me, a per-agent report) is on the roadmap.

### 4. The demo path

- The "Lost in translation" tour (T-19) gains a Huh? step after "What the agent asked": "Still unclear? Press Huh?". The tour then waits for the explanation before "Decide out loud".
- `CONVERSATIONS["reconciliation-path"]` becomes `[{huh}, {narration}]` with expected `["explain", "confirm"]`.
- Re-record the conversations, since the prompt version changes. That is about $0.30.
- Add a ninth eval case: a Huh? on the T-19 card. It passes when:
  - `next` is `explain`;
  - there is no "T-19" and no "v2 reconciliation path" in the reply, unless defined;
  - the reply is at most 700 characters;
  - the reply asks one question at most;
  - the ledger choice is `none`.

## Where the work happens

Branch `stage/6e-huh`, worktree `~/dev/when-to-bug-me-huh`, one PR against main.

Files:
- shared: `converse.ts`, `constants.ts`, `prompts.ts`, `fakeConverse.ts`, `examples.ts`, `tours.ts`;
- page: `card.ts`, `actions.ts`;
- other: `style.css`, `scripts/eval-converse.ts`, the recording, unit tests and e2e tests.

## Graduation gates

```bash
npm run typecheck && npm test
# unit: advance forces explain on a Huh?; explain without a press or unclear feedback becomes ask; explain doesn't count toward the question cap;
# MAX_HUH enforced by parseConverseRequest; Huh? turns excluded from MAX_CONVERSE_TURNS; unclear feedback doesn't set hasFeedback or evidence;
# the stand-in explains a Huh?; recorded.test covers the new script
npm run e2e
# Huh? under the question sends at once and shows the chip and an explanation; the button moves to Bug Me's latest turn; gone after two;
# disabled while a turn is in flight; typed-but-unsent words survive a Huh?; a "yes" after an explanation reads back first;
# the answer log carries unclear: n; 320px has no horizontal scroll
npm run e2e -- --project=recorded-desktop --project=recorded-phone   # the Lost in translation tour, with its Huh? step, on the recording
npm run eval:converse                                                 # 9 of 9 (live; about $0.05)
python3 scripts/scan.py
```

## Out of scope (roadmap)

- Graphics, widgets and explainer videos in an explanation (David, 2026-10-12).
- Turning Huh? counts into guidance for Bug Me, such as a glossary of an agent's terms, or a report of which agents' questions needed the most translating.
- Huh? on older turns, or on a specific phrase.
- Routing the confusion back to the asking agent ("ask it again, more plainly").
