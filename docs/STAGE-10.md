# Stage 10: closing the gaps before pencils down

## Why

David, 2026-10-14: "It needs to be very clear in the PRD what we actually built in the demo versus what would go in a real product release. Obviously, as much as we can get done in the demo before it's pencils down time on Friday, the better."

The PRD's built-versus-release table (the proposal doc's "Proposed updates (Oct 14)" tab) lists four gaps. David chose to close all four by Friday, Oct 16, in this order, cutting from the end if time runs short:

1. **Onboarding for Jordan.** The PRD's first-run experience: Bug Me reads past sessions, drafts the "how to work with me" note, and an interview corrects it.
2. **Reflection prompts.** A break suggested after a demanding stretch, a "were those worth your time?" now and then, and a weekly-review sketch.
3. **David's real note from his history,** drafted on the runner.
4. **Hooks into Bug Me:** every blocking request on David's machines appears in the queue, not just the sessions that call `ask_bug_me`.

David's decisions (2026-10-14):
- **Hooks mirror only.** A hooked question shows in Bug Me, routed and briefed, marked "answer it in the session". David still answers in the terminal, and Bug Me records the answer from the hook's follow-up event.
- **The real note is drafted on the runner,** with David's Claude login, so his history never passes through Cloudflare.
- **The split:** Claude builds 1 and 3, which share the note screen. Two subagents build 2 and 4, each in its own worktree and PR.

Also fixed here: `fixtures/persona.json` says Jordan's note was "Drafted by Bug Me from Jordan's past sessions and corrected by Jordan in an onboarding interview". It was written by hand. After 10a, the demo's onboarding drafts it for real; the label says which run produced it.

## 10a: onboarding for Jordan (public demo)

A new view, `#/welcome`, which Home links to as "How Bug Me got to know Jordan".

**Step 1, the history.** `fixtures/history.json` holds about 30 of Jordan's past questions and answers. They are synthetic and hand-written, consistent with Jordan's projects, rules and facts. Each has an id, a project, the question, the options, Jordan's answer and, sometimes, a typed reason. The page shows the count and a few examples: "I read 30 of your recent decisions."

**Step 2, the draft.** A model call, `noteFor(history)`, drafts at most eight lines.
- Each line names the history ids it rests on (checked by code: ids must exist), and gets a kind: preference, rule-like, or contradiction.
- Lines are limited to what's distinctive about this person. The prompt says so, and says to leave out what any user would say.
- The page shows each line with "from 4 decisions", which opens those decisions.

**Step 3, the interview.** A model call, `interviewFor(note, history)`, asks at most three questions, built from what it saw. Example: "You approved every cleanup without reading it, but rewrote every pricing decision. Is that the line?"
- The person answers by voice or by typing.
- DEMO REPLY gives Jordan's scripted answers.
- A third call, `reviseNote(note, answers)`, returns the final note, marking which lines changed and why.

**Step 4, keep it.** The final note shows with "This is what Bug Me works from" and links to Rules.
- In the demo the morning keeps running on the hand-written note, so recordings and routing stay exact-match. The page says so in one line.
- `persona.json`'s source label becomes accurate: hand-written, with the onboarding demo showing how it would be drafted.

**Shadow period:** one closing line points to it ("Next: a week of guessing before every answer, acting on none"). It runs in the fleet spike, not here.

**Recorded:** the three calls on Jordan's history and scripted answers, so the flow runs with no key. A tour, "Getting to know you", walks it.

## 10b: David's real note (runner, `/me`)

- **`npm run onboard -- <rows.jsonl>`** reads the rows that the research repo's `spike/extract.py` already produces from David's transcripts. Those rows are private and gitignored there, with secrets already replaced.
  - It keeps the most recent 200 questions with their answers and reasons.
  - It trims each to the question, options, answer and reason, with no surrounding context.
  - It posts them to the runner's `/api/me/onboarding` with the owner key.
- **The Worker** drafts with the same `noteFor` (owner context, `store: false`: never cached, recorded or logged) and stores the note in the owner's Durable Object. `/me#/welcome` shows it with the interview, live on the runner's Claude login.
- **Kept lines join David's facts,** each with its source ("from onboarding, 6 decisions"), which he can edit like any other.
- **Nothing private enters the repo:** no rows, no note, no prompt text. A sentinel test covers it, as for Dispatch.

## 10c: reflection prompts (subagent)

- **A break.** On the change-of-project screen, after a demanding stretch (decisions answered, weighted by route, or minutes; thresholds in `constants.ts`), one line suggests a break: "Twelve minutes of real decisions. Stand up before billing?" Dismissible, never blocking.
- **"Were those worth your time?"** At most every third change of project: three taps.
  - "all worth it";
  - "some should have been settled";
  - "none needed me".

  Each tap is logged to the record as `{kind: "feedback"}` and exported with it.
- **A weekly-review sketch.** A view, `#/review`, built only from this browser's record and the queue:
  - where decisions and time went, by project, against the order of the stated priorities;
  - what was settled versus asked;
  - Dispatch spend against estimate.

  Labeled "a sketch of the weekly review, from this morning's record".

## 10d: hooks into Bug Me (subagent; cut first)

- **The hook:** `mcp/bugme-hook.mjs`, dependency-free like `mcp/bugme.mjs`.
  - It is registered by David (the README gives the settings snippet; Claude never edits `~/.claude`) for PreToolUse on AskUserQuestion and ExitPlanMode, and for PostToolUse on the same tools.
  - PreToolUse posts a mirrored ticket: `POST /api/me/tickets` with `mirror: true`, the question, the options, the session id and the project.
  - PostToolUse posts the answer to `/api/me/tickets/<id>/session-answer`.
  - It never blocks: a 2 s timeout, and it exits 0 on any failure (a hook that fails must not stall a session).
- **The Worker:** a mirrored ticket is routed and briefed like any other. Its card says "Answer it in the session", has no send-down, and isn't decided from the page. When the answer arrives, the ticket closes as answered "by session", with the choice. Settle routes never act on a mirrored ticket; Bug Me only records what it would have done (the shadow, live).
- **Privacy:** the same as `ask_bug_me`. What goes to Bug Me is the question and its options, never the conversation.

## Gates

```bash
npm run typecheck && npm test
# 10a: noteFor/interviewFor/reviseNote parse and limits; every note line cites real history ids; recorded
#      onboarding calls match the prompts; persona source label matches what produced the note
# 10b: owner onboarding is store:false (sentinel never reaches cache, recording or logs); rows trimmed and capped
# 10c: feedback logged and exported; break thresholds from constants; review numbers from the record only
# 10d: mirror ticket parse; a mirrored ticket is never settled or sent down; session-answer closes it; the hook
#      exits 0 on timeout and on a refused request (stub server)

npm run e2e
# 10a: #/welcome runs start to finish (fake model and recorded run); DEMO REPLY answers the interview;
#      the "Getting to know you" tour passes on desktop and phone; no horizontal scroll at 320px
# 10c: a break line after a demanding stretch; the feedback taps land in the record; #/review renders
# 10d: a mirrored ticket shows "Answer it in the session" with no decide button, then closes on the session answer

npm run smoke:live                       # extended for 10d: the hook script posts a mirror and its answer
python3 scripts/scan.py
```

**Manual, by David:**
- run `npm run onboard` on his rows on the runner, and read his draft note;
- for 10d, add the hook snippet to his settings, and see one real question mirror and close.

**Spend:** recordings for 10a (Opus, about $0.20). 10b and the smokes run on David's Claude login.

## Out of scope

- Feeding Jordan's onboarding note into the demo's routing (it would change every recording's key).
- Answering a hooked question from Bug Me (mirror only, David's call).
- Permission-request hooks.
- Onboarding from email, meetings or documents.
- A real weekly job.

## PRs

Each PR is under the review cap. 10a, 10c and 10d branch from main; 10b branches from 10a, since they share the note screen.

| PR | Branch | Owner |
| --- | --- | --- |
| 10a | `stage/10-onboarding` | Claude |
| 10b | `stage/10b-real-note` | Claude |
| 10c | `stage/10c-reflection` | subagent |
| 10d | `stage/10d-hooks` | subagent |

A polish branch from another agent (`stage/8c-polish`) also touches `src/page/`, and will be rebased after whichever lands first.

## Codex plan review (gpt-6.1-sol, high, 2026-10-14)

Folded in; these override the sections above where they differ.

- **10a schemas first.**
  - Note lines and interview questions get stable ids.
  - Citations are non-empty, de-duplicated and real.
  - Limits hold after revision too.
  - Evidence from history is kept apart from corrections made in the interview.
  - DEMO REPLY answers are bound to question ids, not to their position.
  - The hand-written note is never fed to the drafting prompt as an expected answer.
  - The labels are "Your drafted note" versus "the morning runs on the hand-written note".
  - The 320 px and recorded e2e projects include the new specs.
- **10b importer contract.** `npm run onboard` converts the extractor's rows:
  - answered questions only, de-duplicated by call and question;
  - sorted by `ts`, then the newest 200;
  - `note` becomes the reason; free-text and multi-select answers are kept;
  - stable ids, and a short project label.

  It prints the count and the date range. The extractor's default cutoff (Oct 2) is stated, with how to move it.
- **10b body limit:** an onboarding-specific body limit, under the runner's 1 MiB and the model's 400,000-character prompt. Every other endpoint stays at 32 KB.
- **10b runner only.** `onboard` targets the runner and uses its own key from `~/.bugme/runner.env`, with no hosted fallback. The hosted Worker refuses owner onboarding (no `LOCAL_MODEL_URL`, no onboarding). All three calls are owner-context `store: false`, with sentinel tests on them and on their failure paths.
- **10b storage:** an onboarding run (id, trimmed evidence, draft, questions, answers, revision) is kept in the owner's Durable Object. Keeping lines merges them into the server's facts idempotently, as facts, never as rules. Settle permission still needs a written rule.
- **10b fact editing:** the Rules view gets a fact editor (240 characters, 30 facts, as today). The owner's note section shows the kept onboarding note and its provenance, in place of the hard-coded note in `ownerPersona()`.
- **10c data honesty:**
  - Time is estimated from the route (labeled as estimated), not measured.
  - Stated priorities are an explicit synthetic order, outside the routing prompts.
  - Dispatch snapshots enter the record with brief ids; missing cost shows as "not reported".
  - Historical answers use the route in the answer event.
  - Cadence and dismissals are persisted per change of project, counted at the action, not at render.
- **10d minimum complete scope:**
  1. A fast ingest path: persist a pending mirror, acknowledge it, then route asynchronously.
  2. Server-side correlation by `session_id`, `tool_use_id` and question index, idempotent, with an answer that arrives before routing finishes kept.
  3. Adapters for AskUserQuestion (multiple questions, up to 4 options, multi-select, typed) and ExitPlanMode (a minimal "Approve this session's plan?" with no plan text).
  4. The server enforces mirror-only: no settling on add or re-route, page resolution refused, no send-down, `by: "session"`.
  5. A cancelled, failed or unknown state for orphans.
  6. Owner polling reconciles mirrors (updates and closes), not only additions.

  Tested with slow routing and a lost acknowledgement. The claim is "best-effort mirroring of Claude Code questions and plan approvals on configured machines".
- **Integration:**
  - Claude owns the shared router and state changes, and runs the combined gates after rebases (polish included).
  - 10b branches from 10a.
  - A completion gate updates the PRD's built-versus-release table with what actually landed.
- **Smoke:** `smoke:live` stays a fake-model integration test. Login-backed checks are named separately.

ROADMAP:
- reliable capture across outages, clients and permission prompts;
- whether the inferred note predicts David well (the fleet spike's job);
- measured attention and complete spend;
- managing history over time (retention, deletion, rolling imports, a real weekly job).

Declined: none.
