# Stage 6e: "Huh?"

## Why

Sometimes a question still doesn't make sense after Bug Me has translated it. David (2026-10-12): one kind of feedback on a question is "the question as posed doesn't make any sense to me, can you retry in plainer, simpler terms?" A scratching-head "Huh?" should get Bug Me to "immediately turn around and re-present in plain English with better context". It is also feedback on Bug Me itself: Bug Me's job is translating the fleet's questions for one person, and a "Huh?" means it didn't do that well. It is different from "the agent asked badly" (routing) or "this wasn't urgent" (priority).

The thread exists so the person can talk back to Bug Me. Confusion is the cheapest kind of talking back, so it gets one press, the way a choice gets one click.

## What changes

### 1. A "Huh?" button

- **🤔 Huh?** sits in two places:
  - under the card's question, until Bug Me has said anything;
  - after that, on Bug Me's latest turn.
- It is never shown on older turns, and never on the "Got it" that follows a typed yes.
- It always refers to the last thing Bug Me showed: the card (briefing, question and options), or Bug Me's latest turn.
- One press sends a turn at once, with no composer and no Send step. The press becomes a Jordan turn `{ who: "jordan", text: "", huh: true }`, shown in the thread as a small "🤔 Huh?" chip on Jordan's side.
- Anything typed but not yet sent stays in the box, and a clicked option stays lit and unsent.
- The button is off while a turn is out or the last turn is unanswered.
- A press that fails shows "Send again". That resends the press itself and leaves the words in the box alone.
- After two presses in one thread it disappears. The person can still type, skip or decide.
- After the press, the explanation is scrolled into view, since it lands below the options.

### 2. Bug Me says it again, plainly

- `Next` gains `"explain"`. An explanation is not an elicitation question, so it never counts toward `MAX_CONVERSE_QUESTIONS`.
- **Prompt (2026-10-13.1).** After a press, or typed confusion ("I don't follow"), Bug Me says the last thing it showed again in plain English:
  - what is going on;
  - what each option would actually do;
  - any term defined;
  - the question again, asked simply.
- **Content limits.** It restates only the agent's material, says plainly when the material doesn't say something, and doesn't lean toward an option.
- **Length.** Up to `MAX_EXPLAIN_CHARS = 700`.
- **Not a question.** Asking what Bug Me meant is feedback of kind `"unclear"`. It is not a question for the agent, and not a reason.
- **`advance` rules:**
  - A press is always answered with an explanation. That is the model's when it returned `explain` with words; otherwise code's own (`plainly`: the context's first two sentences, then the options by label, and the options always fit), with `forced` set.
  - The model may explain without a press only when its ledger marks the newest turn `unclear`. At the thread's limit that becomes the read-back instead, since nothing else can follow it. Any other `explain` is handled as an `ask`, under the usual cap, "stop asking" and thread limit.
  - A yes after an explanation still answers the read-back that was explained. `standingTurn` skips presses and explanations, and is used by `agreesOnly`, the page's `readyToConfirm` and the stand-in. A Huh? on the read-back therefore leaves the decision button lit.
- **The reading doesn't change.** A press has no words. The page keeps the ledger it had before the press, or an empty one for a first press, and ignores whatever the model re-read.
- **Checked on the way in.** "Unclear" clauses are dropped from the ledger's questions, reasons and conditions in `sanitizeLedger`, so "what does that mean?" can't become "Ask the agent".
- **Limits.** Presses don't count toward `MAX_CONVERSE_TURNS`, and have their own cap, `MAX_HUH = 2`. `parseConverseRequest` enforces both: a press has no words and no pick.
- **Without a key.** The stand-in (`fakeConverse`) answers a press, or "I don't follow", with `plainly`, labelled "stand-in" as usual.

### 3. Recorded as translation feedback on Bug Me

- Answer and set-aside log entries carry `unclear: n`, the number of misses: each explanation Bug Me had to give, plus any `unclear` feedback in the final reading that didn't get one.
- It is counted from the thread itself, so a retry adds nothing and a later reading can't drop an earlier miss.
- The thread is logged with the outcome, so each miss can be traced to the turn it followed.
- `unclear` feedback doesn't set `hasFeedback` and doesn't go into the guidance evidence. It says nothing about the person's preferences.
- Turning the count into anything (guidance for Bug Me, a per-agent report) is on the roadmap.

### 4. The demo path

The "Lost in translation" tour (T-19) now runs:
1. What the agent asked.
2. **Still unclear?** Press Huh?
3. **In plain terms.** The explanation, with a note that a Huh? also tells Bug Me its translation missed. Next.
4. Decide out loud.
5. Decide.
6. Guidance.

Supporting changes:
- **Popover placement.** "Decide out loud" steps now point at the box, with the popover above it. On a phone, a tall thread had put the popover over Send.
- **Scripts.** `CONVERSATIONS` has a second T-19 script, `[{huh}, {narration}]`, with expected `["explain", "confirm"]`. The first, narration only, stays, so a visitor who skips the press still replays the recording.
  - "Use Jordan's words" offers only words (`scriptWords`), never a press.
  - `scriptTurn` builds a scripted turn the same way in the recorder, the recording test and the eval.

## As built

### The recording and the eval

Re-recorded 2026-10-13 for the new prompt: 11 calls, $0.20, every script followed.

Bug Me's recorded explanation of T-19 opens:

> "This is about how tax is worked out on invoices during the move to the new payments provider. One option re-does the tax math on every invoice sent since January and sends customers a corrected invoice wherever the total comes out different…"

`npm run eval:converse` now has ten cases. Results for prompt 2026-10-13.1:
- **The first eight:** all passed every trial again.
- **"Huh? on the card":** 3/3. The model itself chose `explain` each time; replies are 120 to 700 characters, say what happens to invoices, ask the question again, and name no agent internals.
- **"Typed confusion":**
  - As first written, "What does T-19 even mean?", it was **0/3**. Claude read it as a question about the agent's own term and answered it from the material ("T-19 is the old lookup table that matches tax codes to invoice line items…"). That is defensible: T-19 is the agent's word, not Bug Me's.
  - The case was rewritten after that run to "I don't follow any of this." It then passed **3/3**: `explain` chosen by the model, `unclear` feedback, no open question.
  - Both runs are in `results/captures/`.
- **Cost:** $0.67 for the full run, and $0.07 for the rerun.

### Codex plan review (gpt-6.1-sol, high, 2026-10-13)

**Folded in:**
- `model.ts` rejected `explain`.
- An explanation could strand the decision at the thread limit. Now a read-back stands through a Huh?, and typed confusion at the limit gets the read-back.
- "Send again" after a failed press would have sent the kept draft instead of the press.
- The re-read ledger could drift after a press. The page keeps its own.
- A forced `explain` showed a non-explanation reply.
- Clarification requests leaked into questions, reasons and conditions.
- The miss count could drop earlier typed confusion.
- The recorder and eval dropped `huh`.
- The tour waited for the wrong reply.
- Smaller points:
  - the stand-in now keeps room for the options;
  - decimals stay whole in the stand-in's sentences;
  - the explanation scrolls into view;
  - the eval checks the raw answer and the explanation's content;
  - the eval cost estimate is corrected.

**Declined:**
- **Sending the card's translated briefing to the model, so it repairs that wording.** The explanation is written from the agent's material, which is authoritative and is what the briefing came from. Carrying the briefing through the request and the recording key is real plumbing for a quality gain we haven't seen we need. On the roadmap.
- **"Run the browser gates unsandboxed."** It doesn't apply to this setup.

## Graduation gates

```bash
npm run typecheck && npm test          # 439 pass: advance, sanitizeLedger, parseConverseRequest, unclearCount, plainly, the stand-in, both T-19 scripts on the recording
npm run e2e                            # 282 pass: tests/e2e/stage6e.spec.ts (press, two-press cap, in flight, read-back stays lit, typed confusion, failed press, 320px) and the recorded tours on desktop and phone
npm run eval:converse                  # 10/10 (live; about $0.70)
python3 scripts/scan.py
```

## Out of scope (roadmap)

- Graphics, widgets and explainer videos in an explanation (David, 2026-10-12).
- Turning the miss count into guidance for Bug Me (a glossary of an agent's terms), or a scorecard with denominators and per-agent attribution.
- Giving the model the card's translated briefing, so it can repair that exact wording.
- Huh? on older turns, or on a specific phrase.
- Routing the confusion back to the asking agent ("ask it again, more plainly"), or fetching material the agent never supplied.
