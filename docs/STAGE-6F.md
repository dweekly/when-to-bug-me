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

## As built

- **Labels.** 36 of 40 decisions have at least one option in Haiku's words. On the other four the agent's labels stay: on three they were already plain (flight times, request limits, "Quarantine with a ticket"), and on tax-mapper-lint the titles answer failed. Code keeps the agent's label wherever a label fails the checks (word count, or an agent code such as "T-19", "R2" or "v2"). All 40 pairs were read by hand (2026-10-13). The two the demo turns on:
  - "Keep T-19 mapping" → "Keep using the old tax table";
  - "Apply v2 reconciliation path" → "Recheck and fix invoices since January".
  Two housekeeping labels lean a little ("Apply fixes now; easy to undo", "Merge three small safe updates"). They show only on an undone job; label fidelity is on the roadmap.
- **Title retries.** Adding the labels line made Haiku's titles a word longer. The prompt now says so plainly (2026-10-13.2). One title, tax-mapper-lint, comes back at seven words on every retry; its row shows the headline, as dockerfile-format's did before.
- **Read-backs.** Recorded read-backs now speak the labels ("Keep using the old tax table and don't rewrite invoices people already paid, but fix the tax going forward. Right?"). Routing was not re-recorded (no route calls in the dry run), so the pros and cons are the recorded ones.
- **The reveal** says a shared expectation once: "The agent would have picked **6:05am flight**, and so would I."
- **The corner firefly** scrolls away with the header on a phone. Pinned, it floated over the thread, the second firefly in David's screenshot.
- **The why box's "Use Jordan's recorded reason" link** is a DEMO REPLY button beside its microphone too.
- **Cost.** Re-recording about $0.42 (mostly the conversation turns; the titles are under a cent); eval 10/10, $0.68.

### Codex plan review (gpt-6.1-sol, high, 2026-10-13)

**Folded in:**
- **The owner page.** `/me` reads labels from the ticket's stored card: its calls never touch the cache. Each world has a `labelsOf`.
- **Recorder, replay test and eval.** All three run the conversation on the plain labels; guidance and routing stay on the agent's.
- **Guidance provenance.** Kept guidance names the option by the agent's label, which feeds routing, so re-routes still replay.
- **Jargon check.** The label check rejects agent codes.
- **Demos.** They no longer say "Take the agent's pick". The conversation prompt (2026-10-13.2) never names the agent's recommendation.
- **The Huh? demo step and its runner** target the new button.
- **The 320px project** includes this spec.
- **A recorded-run test** covers DEMO REPLY on real labels (`tours-plain.spec.ts`).
- **Live asks with no recommendation** are marked `no_recommendation`. The reveal and the against-the-agent nudge only use a real pick.
- **DEMO REPLY** is off while a turn is out.
- **Phone tests** measure the paragraph's width, the follow-up's `::before`, and the space after Demos.
- **Old assertions and the stage 6 doc** are updated.

**Declined or deferred:**
- **The stand-in doesn't get hand-written plain labels.** The scripted T-19 words now say "old tax table", which the keyword stand-in can't match to "Keep T-19 mapping". That only matters on the fake-model server, where no test drives that script. The recorded and live runs use real labels.
- **Re-applying labels when a re-route replaces a card.** Titles don't change on a re-route.
- **Label fidelity, and versioning saved conversations across label changes.** Both on the roadmap.
- **Conditions count as a reason** for the nudge, as before 6f.

## Gates

```bash
npm run typecheck && npm test   # labels parse (fallback per option), plainOptions, shouldAskWhy against the agent, recorded titles carry labels, both T-19 scripts replay
npm run e2e                     # stage6e/6f specs: one Huh? above the box; no agent's pick before deciding; reveal + nudge; DEMO REPLY fills the box;
                                # at phone width Bug Me's words take over 80% of the thread, the source sits under them, no turn or follow-up has its own firefly,
                                # the corner firefly scrolls away, and the views row ends with a gutter after Demos
npm run e2e -- --project=recorded-desktop --project=recorded-phone
npm run eval:converse           # 10/10 again on the plain labels (about $0.70)
python3 scripts/scan.py
```

Re-record: titles (about 40 Haiku calls, under $0.05) and the conversations (about $0.25).

## Out of scope

- Translating the agent chain line (`billing-lead › invoice-migrator › tax-mapper`).
- Translating the payload snippets.
- Plain labels inside the routing prompt.
