# Stage 4: think out loud

## Why

David's review of the stage 3 card (2026-10-11):

- **The card mixed directions.** Options were stacked top to bottom, the payload pictures for A and B came after them in a second A/B run, and the Why box sat off to the right. It read A, B, A, B, plus a sidebar.
- **Clicking A or B invites a knee-jerk answer.** The interesting signal is the person's reasoning: which way they lean, why, any "but…", and what they'd need to know. Asking for it through four separate controls (Why, Yes but…, Something else, Ask a question) made giving it feel like extra work.
- **As clean and minimal as possible** (David, 2026-10-11). The marked-up words are the summary; no table repeating them, no legend.

The intent: the person talks a decision through the way they would with a colleague, and Bug Me picks out the choice, the reasons, the conditions and the questions from what they said, so one pass captures all of it. Another design that gets that one-pass capture with less on screen would also do.

The mockup David reviewed is `docs/stage-4/narrate-mockup.html` (screenshot beside it).

## What changes

**One column of meaning.** Briefing, why it's yours, the question, then any shared figure (timeline, bars, chart, clocks) above the options, since it describes both. The options sit side by side (stacked on phones), and each option carries everything about itself: label, pros and cons, consequence, the agent's pick, and for payload visuals the one line that differs (`"user_id": "usr_41aa"`). The two clickable prototypes (settings redesign) sit in two columns directly above the options, in the same order. Below a thin rule: the talking area, one Send button, and "Not now" as a quiet link. The Why panel, "Yes, but…", "Something else", "Ask a question", their panels, and the Undo bar are removed.

**Think out loud.** One text area below the options, empty with the placeholder "Talk it through, or pick one." The always-on microphone writes finished phrases into it (voice.ts already appends to the target box); typing works the same. The text is the person's words and stays editable.

**Marks.** After each finished phrase (or 1.2 s after typing stops), the page sends the decision and the full text to a new endpoint, `/api/parse`. Claude returns:
- `choice`: one of the decision's option keys, `"other"` when the person describes a different course, or `"none"`;
- `other`: the different course in the person's words, when `choice` is `"other"`;
- `marks`: up to 8 `{ kind: "choice" | "why" | "but" | "ask", quote }`, each `quote` copied exactly from the text.

Code keeps a mark only if its quote occurs in the text as it is now (the same verification the route uses for quoted rules), and drops the rest. Marks are drawn on a layer behind a transparent-text textarea with identical metrics, so editing, selection, voice and screen readers all work on a plain textarea. The choice mark is lit (firefly yellow, the one accent); why gets a faint solid underline, but a dashed one, a question a dotted one. A response is applied only if it is for the latest request (sequence guard, as `askQuestion` does today). Marks never decide anything by themselves.

**Choosing.** Clicking an option card picks it: the card lights, nothing is sent. A spoken or typed choice picks too. The most recent signal wins: a click overrides an earlier spoken choice, and a new spoken choice (one that differs from the previous parse's) overrides an earlier click.

**Questions.** When a parse returns an `ask` mark whose quote is new, the page asks it through the existing `/api/ask` and shows the answer indented under the text ("Agent: …"). If the agent's material doesn't answer it, the line says so.

**Send.** The button names what it will send and is disabled until there is something to send:
- a chosen option: "Send: keep user_id", or "Send: keep user_id, with one condition" when there are `but` marks;
- `choice: "other"`: "Send: <their course>", recorded as "something else" (existing `chooseOther`);
- no choice and an unanswered question: "Ask the agent, and set this aside" (existing `sendQuestionToAgent`).

On Send the page finishes any phrase being spoken (`drainVoice`), waits for the parse of the final text (at most 5 s; if it fails, an option click still decides, with the whole text as the reason and no conditions), then answers through the existing path: pushback, sealed guess, "I'm curious: why?", proposed guidance, send-down. The reason given to that path is the `why` quotes joined, verbatim (the whole text if there are none); the conditions are the `but` quotes, verbatim, sent down with the answer and offered as guidance as today. Bug Me never paraphrases the person into their own record. Send is the confirmation, so the Undo window and `pending` phase go.

**Without a key.** The fake model gets a deterministic parser (option labels and their key words pick; "because/since" marks why; "but/as long as/unless" marks but; a sentence ending "?" marks ask). Recorded mode replays recorded parses on exact match. Tours offer "Use Jordan's words": a recorded narration per tour decision that fills the text, and its parse, ask and fact calls are all in the recording. The parse call has its own prompt version, so the existing recordings stay valid; the recorder adds the new calls.

**Tours** are re-scripted: say it (or use Jordan's words), see the marks, Send. Undo steps go.

## Graduation gates

```bash
npm run typecheck && npm test            # parse: schema per decision, quote verification, choice precedence, Send label states, fake parser
npm run e2e                              # all projects (desktop, phone, 320px, recorded-desktop/phone): every tour start to finish on a keyless server; no horizontal scroll at 320px
npm run eval:parse                       # NEW: 6 narrations x 3 live trials, expected choice and mark kinds written first; passes only if every trial gets the choice right and every kept mark verifies
python3 scripts/scan.py
```

Plus Lighthouse accessibility at 100 on a decision card at phone width, and screenshots of a card mid-narration at 1280 and 390 wide, checked by eye against the mockup.

## Out of scope

- The fixture rework so most of the night is settled (next PR, Tuesday).
- Parsing words still being spoken (interim results); only finished phrases are parsed.
- Changing the route, fact or ask prompts, or the pushback, why and guidance rules.
- "Not now"'s panel (stays as is).
