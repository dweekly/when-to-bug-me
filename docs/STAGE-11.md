# Stage 11: answering the submission review

## Why

A reviewer read the whole submission on 2026-10-14. Two of their points are about the demo:

- **Prompt count.** In the flight walkthrough, Bug Me asked why, read the reason back, then argued with it using the "cheapest" travel rule, though the school drop-off reason already explained the exception. Then it asked whether to keep the guidance. Each step makes sense alone; together they turn one decision into several prompts. They suggested suppressing pushback when the reason already explains the exception, and measuring total human time and decision quality, not just questions kept out of the inbox.
- **Safeguard wording.** Code checks that a quoted rule exists, not that it authorizes the action. On the live queue, cost and reversibility come from the asking agent. They asked the docs to separate checked limits from agent-supplied claims, and to say how an MVP would enforce permissions and reversibility on its own.

Their other points (the memo's numbers, the forecast's scope, the 11-of-17 claim, "Why Anthropic") are about David's prose. They are comments on the proposal doc, not code.

## David's decisions (2026-10-14)

- **Pushback:** skip it when the person has already given a reason. This is a code rule, with no model call or re-recording. A bare pick, or "just do it", still gets the rule quoted back once.
- **The dimming firefly stays.**
- **Human time is measured** in the record and the weekly review, next to the route-based estimate.

## What changed

- **Pushback.** `shouldPushBack` (`src/shared/lifecycle.ts`) needs no reason given. The flight tours drop their pushback step, and the SDK tour, answered "Just do it", keeps its own.
- **Measured attention.**
  - `src/page/attention.ts` times each stretch a decision's card is on screen, open and unfinished, while the tab is visible. Every follow-up on the card counts.
  - When the card leaves the screen, it logs `{kind: "attention", id, seconds}` to the record, so the export carries it.
  - `#/review` shows the measured total under "Where the time went", and each project's measured time after its estimate.
- **README.** The settle invariant now lists what code checks, what it doesn't check, where the limits come from (hand-written in the demo, declared by the agent live), and what an MVP would add.

## Gates

```bash
npm run typecheck && npm test   # shouldPushBack with a reason; measured attention summed per project
npm run e2e                     # pushback.spec: no reason → pushback, reason → none; reflection.spec: a stretch is
                                # logged once and shown in #/review; a hidden tab stops the clock
python3 scripts/scan.py
```

## Out of scope

- Decision quality: nothing here measures whether answers were right (ROADMAP).
- Asking the model whether a reason explains the exception (David chose the code rule).
- Removing the guidance offer, or the dimming firefly.
