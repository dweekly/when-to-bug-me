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
- `marks`: up to 8 `{ kind: "choice" | "why" | "but" | "ask", quote }`, each `quote` copied exactly from the text.

Code keeps a mark only if its quote is a literal substring of the text (no whitespace or case folding; the Worker parses the raw text, not a whitespace-collapsed copy), and drops the rest. One limit, `MAX_REASON_CHARS` (600), applies to the text everywhere: typing, voice, parse, and the downstream calls. The textarea is mounted once per card; marks, the lit option, the Send label and question answers update in place, so typing never loses focus, selection or undo history (full renders stay for lifecycle transitions). Marks are drawn on a layer behind the textarea with identical metrics, hidden from assistive technology; the textarea's own text stays visible, so it reads fine without the layer. The choice mark is lit (firefly yellow, the one accent); why gets a faint solid underline, but a dashed one, a question a dotted one. Overlaps are resolved only for drawing; Send uses every verified mark. Marks never decide anything by themselves.

A parse applies only to the exact text revision it was asked about: every edit bumps the flow's revision, and a response for an older revision is dropped. Finished voice phrases parse at once (a small callback on the voice target); typing parses after 1.2 s idle.

**Choosing.** Clicking an option card picks it: the card lights, nothing is sent. A spoken or typed choice picks too. The most recent signal wins: a click overrides what was already said; a later parse whose choice differs from the previous parse's overrides the click. If the spoken choice is deleted (the parse says `"none"`), a choice that came from speech clears; a clicked one stays.

**Questions.** Each `ask` mark is asked once through the existing `/api/ask` (a per-flow map keyed by the exact quote: pending, answered, missing, failed); the answer shows indented under the text. Only questions still in the text are shown or forwarded. "Unanswered" means the agent's material came back without an answer, not a request in flight or a failure.

**Send.** The button names what it will send and is disabled until there is something to send:
- a chosen option: "Send: keep user_id", or "Send: keep user_id, with one condition" when there are `but` marks;
- `choice: "other"`: "Send: something else", recorded as "something else" (existing `chooseOther`), with the person's `choice` quotes as the course;
- no choice and unanswered questions: "Ask the agent, and set this aside" (existing `sendQuestionToAgent`, all unanswered questions together).

Send claims the submission synchronously (a flag, so a second click does nothing), keeps the voice target while it finishes any phrase being spoken (`drainVoice`), snapshots the text, and waits for the parse of exactly that revision (at most 5 s; a late response is then ignored). After every wait it re-checks that the flow, the card on screen and the routed card are unchanged. If the parse failed: a clicked option still decides, with the whole text as the reason and quoted verbatim in the send-down; with no click, nothing is sent and the card says so, ready to retry. Then the existing path: pushback, sealed guess, "I'm curious: why?", proposed guidance, send-down, with the captured flow passed through rather than the global one.

What goes into that path, all verbatim (Bug Me never paraphrases the person into their own record): the reason is the `why` quotes joined (empty when the parse found none, so "I'm curious: why?" still asks); the conditions are the `but` quotes, sent down with the answer and given to `/api/fact` together with the reason; the whole text is kept in the record as `narration`. Parsed marks are stored as `narrationMarks`, apart from the existing feedback `marks`. Send is the confirmation, so the answer's Undo window and `pending` phase go (the settled-decisions Undo stays).

**Prototypes and payloads.** Each option's column holds its own prototype (settings redesign) above its card, so a phone reads prototype A, option A, prototype B, option B. Payload visuals show each option's changed line in its card (`payloadLine`), with the reach caption once below.

**Without a key.** The fake model gets a deterministic parser: sentences and inline clauses split without changing their text; a "?" sentence asks; "but/as long as/unless" marks a condition; "because/since" a reason; an option's full label (word boundaries) picks, ignoring questions, reasons and negated mentions; ambiguous means `"none"`. Recorded mode replays recorded parses on exact match. Tours offer "Use Jordan's words": a recorded narration per tour decision that fills the text. The recorder runs each narration through its parse, derives the ask, fact and re-route calls with the same helper the page uses, and records them all. The parse call has its own prompt version, so existing recordings stay valid. Editing Jordan's words beyond the recording shows the existing "couldn't evaluate" state and keeps the draft.

**Tours** are re-scripted: say it (or use Jordan's words), see the marks, Send. Undo steps go.

## Graduation gates

```bash
npm run typecheck && npm test            # parse: schema per decision, quote verification, choice precedence, Send label states, fake parser
npm run e2e                              # all projects (desktop, phone, 320px, recorded-desktop/phone): tours in every project; answering helpers use Send; the old lifecycle regressions kept; 320px covers narration, a long Send label, payload and prototypes
npm run eval:parse                       # 6 narrations x 3 live trials, expectations written first; passes only if every trial gets the choice and every expected mark kind, with no mark dropped as inexact
python3 scripts/scan.py
```

Plus Lighthouse accessibility at 100 on a decision card at phone width; screenshots of a card mid-narration at 1280 and 390 wide, checked by eye against the mockup; and a by-hand check of caret, selection, scrolling and keyboard editing in the marked textarea.

First eval run (2026-10-12, before the UI): 6/6 narrations, 18/18 trials, 1.4–4.8 s per parse, $0.12 in all.

## Out of scope

Codex reviewed this plan once (2026-10-12); its points are folded in above. Its roadmap items (the full lifecycle for "something else", real question delivery, voice privacy, parser quality at scale) are in `ROADMAP.md`.

- The fixture rework so most of the night is settled (next PR, Tuesday).
- Parsing words still being spoken (interim results); only finished phrases are parsed.
- Changing the route, fact or ask prompts, or the pushback, why and guidance rules.
- "Not now"'s panel (stays as is).
