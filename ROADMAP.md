# Roadmap

fresh as of 2026-10-11 · stack-ranked; the top is the current work. The prototype's own stages are in `docs/BUILD-PLAN.md`; this file holds what comes after, and concerns raised in review that belong outside the current effort.

## Prototype, before submission (October 16)

- A real-microphone check of the voice firefly in Chrome and Safari (the tests use a stand-in recognizer).
- A keyboard-only and screen-reader pass (Lighthouse at phone width: explainer 100, app 100 after the contrast fix).

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

## From the stage 4 plan review

- **"Something else" as a full answer.** Today a course outside the options is recorded and sent down, but skips pushback, the guess reveal, "why?" and guidance, because the answer and fact calls only know the listed options. Compare and learn from arbitrary alternatives.
- **Real question delivery.** `/api/ask` answers only from what the agent supplied, and unanswered questions are sent back as a simulation. Agents that fetch evidence and answer back belong with real execution.
- **Parser quality at scale.** Six designed narrations are a demonstration gate. Held-out language, long or rambling sessions, adversarial input, and the cost of a parse per phrase over a whole morning.

## Tech debt to schedule

- Re-routing candidates come from topic tags plus the model's suggestions; a rule edit re-checks everything waiting. A cheaper, more complete dependency signal would help.
