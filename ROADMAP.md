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

## From the stage 6 plan review

- **Read back only when there is ambiguity** (David, 2026-10-12: "I don't know that a full readback is necessary to the user unless there is potential ambiguity"). Today every decision is read back before it closes, and a typed "yes" is checked against a fingerprint of what was read back. Closing on a clear answer, and reading back only a paraphrased condition, another course, a rejected question or a correction, would remove most of that machinery.
- **Choosing what to raise next from what was just said.** David's "next best thing" idea: the next decision is the one an answer just made most urgent or most changed, not the next card in a project pile, with an eye on how long Jordan has spent.
- **Conversation quality beyond the designed cases.** Eight scripted conversations demonstrate the mechanism. Held-out people, implicit reasons, contradictory accounts, long sessions and adversarial material need a broader eval.
- **Server-owned threads.** Today the transcript, question count and ledger live in the browser. Accounts, multi-device recovery and idempotent turns belong with durable records.
- **Streaming Bug Me's replies,** token by token, once a reply's latency is measured on real use.
- **Retire `/api/parse` and `/api/ask`** once nothing records or evals through them.

## From the stage 6e plan review ("Huh?")

- **Explanations with pictures, widgets or a short video** (David, 2026-10-12), for decisions words explain badly.
- **Make the miss count useful:** a scorecard with denominators (cards shown, threads abandoned), attributed to the asking agent, and guidance for Bug Me drawn from it (a glossary of an agent's terms).
- **Repair the exact wording that failed:** give the model the card's translated briefing and headline (bounded, through the request and the recording key), not only the agent's material.
- **Huh? on an older turn or a single phrase,** and sending the confusion back to the asking agent ("ask it again, more plainly") or fetching material the agent never supplied.
- **Explanation quality beyond the designed cases:** indirect confusion, accurate definitions, and a second explanation that differs from the first.

## From stage 6f (the card in Jordan's words)

- **Label fidelity:** an eval that a plain label says what the option does, keeps its conditions, stays distinct from its sibling and doesn't lean (two of 40 lean a little today: "easy to undo", "safe updates").
- **Translate the rest of the card's agent language:** the agent chain (`billing-lead › invoice-migrator › tax-mapper`) and payload snippets.
- **Saved conversations across label or prompt changes:** a thread saved under older labels replays against new recordings; version its inputs, or keep a label snapshot with it.

## From the stage 7 plan review (live fire)

- **Verify what agents declare.** Live asks carry the agent's own claims of reversibility and cost; settling trusts them within a $1 ceiling and permission-granting rules. Independent checks (deploy target, money at stake, data touched) would let Bug Me settle more, safely.
- **Execution acknowledgments and retraction.** A session receiving an answer isn't the same as acting on it, and reopening can't undo what already happened. Agents should acknowledge, and undo should compensate.
- **Session continuity.** A session that stops checking never hears a late answer or a reopening. Durable session recovery, and adding to an existing ask instead of a new one.
- **Scoped credentials.** One token serves the MCP server and the browser sign-in. Separate intake keys, device revocation, sign-out.
- **Answering without the model when its budget is spent** (David, 2026-10-12: roadmap, not fixed in stage 7). An ask that couldn't be routed is kept as the owner's decision, but the page answers only through a conversation turn, which needs the model; a model-free "just pick an option" path would let the owner answer it anyway.
- **Cross-device follow-ups on /me** (Codex, fourth pass on #32; David, 2026-10-12: edge cases after the third pass go here). (a) A follow-up to an "other" or rejected answer should also match its course, so one tab's old course can't replace another's newer one. (b) On reload, a saved local answer should be replaced by the server's current answer (the queue would carry the answer's identity), dropping its stale follow-ups. (c) When guidance is saved but can't attach to an answer changed elsewhere, the decisions it affects should still be re-checked.
- **Queue retention, backups and notifications.** Old tickets stay in the Durable Object; nothing pings David's phone when something new arrives.

## Tech debt to schedule

- Seven formatting decisions have an option labeled "Skip" (leave the code as is), the same word as the card's set-aside link. Those cards reach Jordan only after a rule change. Relabel them ("Leave as is") at the next re-recording, since the label is part of the recorded routing prompt.
- Re-routing candidates come from topic tags plus the model's suggestions; a rule edit re-checks everything waiting. A cheaper, more complete dependency signal would help.
