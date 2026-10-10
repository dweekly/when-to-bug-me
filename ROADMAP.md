# Roadmap

fresh as of 2026-10-09 · stack-ranked; the top is the current work. The prototype's own stages are in `docs/BUILD-PLAN.md`; this file holds what comes after, and concerns raised in review that belong outside the current effort.

## Prototype, before October 13

- **Stage 3** ([`docs/STAGE-3.md`](docs/STAGE-3.md)): piles on Home with one recommended pile; a decision card that briefs before it asks, answered by clicking an option (with Undo), with "Yes, but…", "Something else" and "Ask a question"; per-option pros, cons and consequences from Claude; always-on voice shown by the clay firefly.
- **The explainer page at `/`** (branch `stage/2f-explainer`), with the overnight sort redrawn as a queue forming, to match Home.
- The readiness eval (`npm run eval`): three fresh provider calls per condition on each designed pair, against hand-written expected outcomes, plus one paraphrased reason through the whole loop.
- A keyboard-only and screen-reader pass; Lighthouse at desktop and phone widths.
- Production on `bugme.weekly.org`, on David's go.

## After the prototype (from the plan review)

- **Calibration and accuracy, measured properly.** Disagreement with strong agents, probability calibration, held-out people and tasks. The prototype makes no such claim.
- **Real execution and reversal.** Delivery to real agents with acknowledgments, retries and permissions; compensating actions for undo once decisions touch external systems.
- **Long-term guidance management.** Expiry, contextual exceptions, conflicting policies across projects, and preferences that change.
- **Accounts and durable records.** Authentication, multi-device sync, team-owned policy.
- **Smarter scheduling.** Critical paths, deadlines and starvation prevention beyond "most agents unblocked, then longest waiting".
- **Production abuse resistance.** Distributed abuse analysis, auditable decision records, adversarially blind prediction collection.
- **Richer voice and mascot behavior,** with evidence that the glow actually encourages reflection. Production voice: support beyond Chrome, offline transcription, long-session recovery, and audio privacy controls beyond a notice.
- **Working sessions, not just questions.** Some work needs a run of fast exchanges rather than one decision: visual or taste calls (a render, a layout, a tone of voice) where the person gives notes on several cheap previews in quick succession before anything expensive runs. Bug Me should recognize these, schedule them as one focused burst, ask agents for previews and a spread of options instead of finished work, and carry the person's taste notes into later rounds.
- **Abuse protection for a public deployment.** Turnstile in front of live calls with short-lived session tokens (the code exists, behind `TURNSTILE_SECRET`) and the Workers rate-limiting binding. The demo relies on the key's workspace spend limit and the daily cap in code.

## Tech debt to schedule

- Re-routing candidates come from topic tags plus the model's suggestions; a rule edit re-checks everything waiting. A cheaper, more complete dependency signal would help.
