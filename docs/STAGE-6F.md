# Stage 6f: the card in Jordan's words

## Why

David's review of 6e on staging-sized screenshots, 2026-10-13:

- **Huh? placement.** It belongs after the options, just above the "Talk it through" box, not under the question or on Bug Me's turns.
- **The phone thread was "terrible terrible terrible":**
  - two fireflies;
  - Bug Me's words wrapped after a few words, squeezed by a "recorded" label and a Huh? button in the same row.
- **Jargon in the options.** "Keep T-19 mapping" and "Apply v2 reconciliation path" are the agent's words, not Jordan's. The pros and cons are excellent and must not change.
- **The agent's pick on the card.** David's call: reveal it only after deciding. Then, if Jordan's choice differs from the agent's pick or from Bug Me's guess, Bug Me nudges for more clarity.
- **Demo controls.** "Use Jordan's words (recorded)" next to Send becomes a **DEMO REPLY** button next to the microphone.
- **The header.** Drop "Synthetic · recorded Claude". "Tours" had no right padding on a phone, and its meaning wasn't clear; it becomes **Demos**.

The layouts were agreed as mocks first: scratchpad screenshots, five states, at phone and desktop width.

## What changes

1. **One Huh? button,** in a row of its own between the thread and the box.
   - It refers to the last thing Bug Me showed, as before.
   - The buttons under the question and on turns are gone.
   - The rules for when it shows are as in 6e (`canHuh`).
2. **Bug Me's turns.**
   - A grid: the text takes the full width, and the source label sits small underneath.
   - At phone width (≤560px), the turns and the after-decision section drop their own firefly, since the corner firefly is Bug Me.
3. **DEMO REPLY** sits inside the box, left of the microphone.
   - It is shown when there are scripted words for the next turn and the server isn't live.
   - It fills the box exactly as the old link did.
4. **Option labels in Jordan's terms.**
   - The titles call (Haiku 5.5, `TITLE_PROMPT_VERSION` 2026-10-13.1) also returns `labels`: one per option, at most 6 words, plain words, no agent codes or internal names.
   - A label that fails the checks falls back to the agent's label. It never fails the title.
   - The Worker puts them on the card (`card.labels`), next to `emoji`/`title`/`done`.
   - The page swaps them into its copy of the decision when the queue loads (`plainOptions`), keeping the agent's label as `agent_label`. More context lists the agent's options when they differ.
   - `/api/converse` applies the same swap from the same titles source, so Bug Me's read-backs and the decision button say the same words. The prompt also shows the agent's label, so a reply can relate the two.
   - The routing prompt doesn't change, so the pros and cons are byte-for-byte the recorded ones.
5. **Jordan's scripted T-19 words** say "Keep the old tax table" rather than "Keep the T-19 mapping".
6. **The agent's pick and the nudge.**
   - No "the agent's pick" on the option.
   - After the decision, one line: "The agent would have picked **X**." (or "this one too"), then "My guess was **Y**." (or "this one too").
   - `shouldAskWhy` asks when the answer went against the agent or against a confident guess, Jordan gave no reason, and Jordan didn't say to stop asking.
     - The conversation having asked once no longer silences it: the reveal is new information.
     - Its lead is "What made you go against the agent?" when that is what happened, and otherwise "I'm curious: why this one?"
   - With a reason given, guidance is proposed as today.
7. **Header.**
   - The synthetic pill is gone. The live page's "Live · your real queue" stays.
   - "Tours" becomes "Demos": the button, the menu, the restart notice.
   - The phone nav keeps its right padding when scrolled to the end.

## Gates

```bash
npm run typecheck && npm test   # labels parse (fallback per option), plainOptions, shouldAskWhy against the agent, recorded titles carry labels, both T-19 scripts replay
npm run e2e                     # stage6e/6f specs: one Huh? above the box; no agent's pick before deciding; reveal + nudge; DEMO REPLY fills the box;
                                # at 390px Bug Me's turn text is at least 80% of the thread's width and no turn shows a firefly; header fits at 320px
npm run e2e -- --project=recorded-desktop --project=recorded-phone
npm run eval:converse           # 10/10 again on the plain labels (about $0.70)
python3 scripts/scan.py
```

Re-record: titles (about 40 Haiku calls, under $0.05) and the conversations (about $0.25).

## Out of scope

- Translating the agent chain line (`billing-lead › invoice-migrator › tax-mapper`).
- Translating the payload snippets.
- Plain labels inside the routing prompt.
