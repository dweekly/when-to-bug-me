# Roadmap

fresh as of 2026-10-09 · stack-ranked; the top is the current work. The prototype's own stages are in `docs/BUILD-PLAN.md`; this file holds what comes after, and concerns raised in review that belong outside the current effort.

## Prototype, before October 13

- Turnstile in front of live calls, issuing a short-lived signed session token that every paid endpoint requires, plus the Workers rate-limiting binding. Required before a live key goes on any public deployment.
- The readiness eval (`npm run eval`): three fresh provider calls per condition on each designed pair, against hand-written expected outcomes, plus one paraphrased reason through the whole loop.
- A keyboard-only and screen-reader pass; Lighthouse at desktop and phone widths.
- The animated firefly, when its assets land, in place of the CSS glow.
- Production on `bugme.weekly.org`, on David's go.

## After the prototype (from the plan review)

- **Calibration and accuracy, measured properly.** Disagreement with strong agents, probability calibration, held-out people and tasks. The prototype makes no such claim.
- **Real execution and reversal.** Delivery to real agents with acknowledgments, retries and permissions; compensating actions for undo once decisions touch external systems.
- **Long-term guidance management.** Expiry, contextual exceptions, conflicting policies across projects, and preferences that change.
- **Accounts and durable records.** Authentication, multi-device sync, team-owned policy.
- **Smarter scheduling.** Critical paths, deadlines and starvation prevention beyond "most agents unblocked, then longest waiting".
- **Production abuse resistance.** Distributed abuse analysis, auditable decision records, adversarially blind prediction collection.
- **Richer voice and mascot behavior,** with evidence that the glow actually encourages reflection.

## Tech debt to schedule

- Re-routing candidates come from topic tags plus the model's suggestions; a rule edit re-checks everything waiting. A cheaper, more complete dependency signal would help.
- `src/page/main.ts` is one file; split rendering from actions if it grows further.
