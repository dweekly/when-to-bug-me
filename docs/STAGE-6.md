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

1. **Bug Me's opening.** The briefing, why it came to Jordan (the routed card's reason, in plain words), "More context" (folded), the question, and the options in columns, exactly as the stage 4 card lays them out. Nothing here calls the model.
2. **The conversation.** Jordan's turns are right-aligned, Bug Me's left with the small firefly. A composer sits under the last turn: a text box with the microphone button inside it. Clicking an option still picks it (the column lights); the pick travels with the next turn.
3. **The actions row**, bottom of the composer: "Skip" at the left, the primary action at the right ("Send", then "Yes, send: keep user_id" once Bug Me has read it back).

**Each of Jordan's turns** goes to a new endpoint, `/api/converse`, with the decision, the routed card, Jordan's rules and facts, the transcript, the ledger so far, the turn count and the seconds spent. Claude returns, under a JSON schema:

- `reply`: Bug Me's next turn, at most two sentences and at most one question;
- `ledger`: what it heard so far:
  - `choice`: an option key, `"other"` (a different course), `"reject"` (Jordan rejects the question or its framing), or `"none"`;
  - `course`: Jordan's own words for "other" or "reject";
  - `why`, `conditions`: quotes;
  - `questions`: Jordan's questions, each with the answer from the agent's material or `null` when the material doesn't say;
  - `feedback`: quotes about the question itself, each tagged `priority` (more or less urgent than framed) or `routing` (should or shouldn't have come to Jordan);
- `next`: `"ask"` (Bug Me needs one more thing), `"confirm"` (the reply reads the outcome back), or `"close"` (Jordan confirmed).

Every quote must be a literal substring of one of Jordan's turns (`findQuote`, as for parse); unverified quotes are dropped. The verified quotes are drawn as marks on Jordan's sent turns, with the same four styles as stage 4.

**Persistence, enforced by code as well as the prompt.**
- A bare pick, with no why, gets one light follow-up ("Why that one?").
- Bug Me asks at most two questions per decision. After the second, code forces `next` to `"confirm"` whatever the model said.
- "Just do it", "skip it", or a pick with "no more questions" is respected at once: the reply goes straight to the read-back.
- The read-back always comes before close. Jordan can confirm with the primary button or correct it in words; a correction is a normal turn.

**Close.** When Jordan confirms, the ledger feeds the existing path unchanged in substance:
- choice, reason (the `why` quotes joined), conditions and narration (all of Jordan's turns) go through `answer` → pushback → `finalize` → `propose`;
- a pushback, the hidden guess ("My guess, hidden until now…"), "I'm curious: why?", and "Remember this for every agent?" become Bug Me turns in the same thread, with their buttons in the actions row (primary on the right);
- `feedback` quotes join the evidence given to `/api/fact`, so "you shouldn't have asked me this" can become a rule;
- `"other"` goes through `chooseOther` with `course`; `"reject"` is recorded as its own outcome (`rejected`, with Jordan's words sent down to the agent verbatim);
- unanswered `questions` with no choice go through `sendQuestionToAgent`, as today.

"I'm curious: why?" rarely fires now, because the conversation already asked; it stays as the backstop.

**What goes.** The as-you-type parse (`/api/parse` from the page) and the per-quote `/api/ask` calls go: the conversation does both jobs once per turn. The endpoints and their recordings stay for the eval and history until a later cleanup (ROADMAP).

**Without a key.**
- The fake model gets a deterministic `fakeConverse`: a bare option label gets "Why that one?"; a turn with "because"/"since" gets the read-back; a "?" gets the first sentence of the context or "I don't know; I'll ask the agent"; "yes"/"right"/"send it" closes; "neither"/"wrong question" marks a reject.
- Recorded mode replays exact transcripts. Each tour decision gets a scripted conversation (two or three of Jordan's turns). `scripts/record.ts` plays them against live Claude and records every call, and fails if a recorded `next` differs from the script's expectation. Tours offer "Use Jordan's words" per turn, on live servers too: an exact replay is free and deterministic. That also fixes today's bug, where the tour text says "Or use Jordan's words" on a live server that hides the button.

**Cost.** One model call per turn of Jordan's, about $0.02–0.04 at effort low. A decision is usually two or three turns. The daily spend cap stays.

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
- items grouped by kind of work, each group with an icon (branch cleanup, dependency updates, formatting, flaky tests, and so on);
- one short line per item: what was done;
- three icon buttons per item, with labels: Undo, Ask!, Disagree;
- no rings, no codes, no per-item Why. The rule that allowed an item shows only on request, in plain words.

It is built only after David approves the mock.

## Where the work happens

Three PRs, each under the review size cap:
- `stage/6a-fixes`: section 2, and section 3 once the mock is approved.
- `stage/6b-converse`: the endpoint, prompt, schema, `fakeConverse`, recorder, eval, unit tests.
- `stage/6c-thread`: the thread UI, the close path, tours re-scripted, e2e. Based on 6b.

## Graduation gates

```bash
npm run typecheck && npm test        # converse: schema per decision, quote verification, the two-question cap, the forced read-back, close-path mapping (option, other, reject, ask-the-agent), fakeConverse
npm run e2e                          # desktop, phone and 320px on the stand-in; every tour on the keyless recorded server at desktop and phone
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

On every turn: at most one question mark in the reply, and no unverified quote.

Plus: Lighthouse accessibility at 100 on a thread at phone width; screenshots of a three-turn thread at 1280 and 390 wide, checked by eye; David's real-microphone check on staging.

## Out of scope

- Bug Me choosing which decision to raise next from what was just said (the "next best thing" ordering). The piles stay; it goes on the roadmap.
- Streaming Bug Me's replies token by token.
- Changing the route, fact or answer prompts, or the pushback, guess and guidance rules.
- Removing `/api/parse` and `/api/ask` from the Worker.
- A production deploy (David's go).
