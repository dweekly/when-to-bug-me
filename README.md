# Bug Me

**A chief of staff for people who run fleets of agents.** Every question your agents raise flows into Bug Me instead of interrupting you. It settles what your written rules already cover (and only if it is reversible and cheap), puts the rest in the order to work them, briefs you before it asks, takes your answer in one click or one sentence, asks you why when your answer surprises it, and turns your reasons into guidance every agent follows from then on.

**Try it:** [bugme.weekly.org](https://bugme.weekly.org), live Claude behind a daily spend cap. This repo is the MVP for an Anthropic Labs take-home (the assignment calls it the working prototype); the proposal calls what would ship to customers v1.

Every document in this repo is indexed under [Documents](#documents) at the end: what is in it, when it last changed, and what would bring someone back to it.

> **Everything here is synthetic.** Jordan Okafor, Larkspur, the twenty agents and all 40 of their questions are made up. No real agent receives anything Bug Me "sends down".

## Try it in two minutes

The front page is a short explainer; each tour card opens a guided tour of the real app that points and lets you click. Or open the app and play Jordan, a staff engineer whose fleet raised 40 questions overnight:

1. **Home** shows the night as piles, one per project, and suggests where to begin ("Suggested first: Launch project, 5 questions, about 11 minutes, because answers here unblock 14 agents, the most of any project"). Of the 40 questions, 31 were housekeeping Bug Me settled for Jordan without asking (formatting, lint fixes, patch-level bumps, merged branches, flaky-test quarantines), each reversible, free and cleared by a written rule; 9 wait for Jordan.
2. **A decision card** briefs you first (what is going on, and why it is yours, quoting the rule), then asks. The options sit side by side, each with its own pros, cons and cost (and, where there is one, its line of the payload or its clickable prototype).
3. **Talk it through.** The card is Bug Me's opening; below it is a conversation. Say or type it the way you would to a colleague: which way you lean, why, any "but…", any question, or reject the question outright. Or just click an option and Send. Bug Me replies: a bare click earns one light "Why that one?"; a question gets an answer from what the agent provided (or "I'll ask the agent"); "just do it" stops the questions. Your turns are marked with what it heard, each an exact quote. When it has enough, it reads the decision back in a line, and the button becomes the decision itself ("Keep user_id"). Nothing goes out until you press it, and Bug Me's guess stays sealed until then. If the card or Bug Me's last line doesn't make sense, press **🤔 Huh?**: Bug Me says it again in plain English, and counts it as a miss on its own translation.
4. Then Bug Me reveals what the agent recommended and which choice it expected you to make (neither shows before you decide; the expectation is a forecast of you, not Bug Me's opinion), and your reason becomes proposed guidance; keep it, and the waiting decisions it touches are re-checked with the cause shown (the 7:30am Berlin invite is reframed by a reason given on the flight). If you went against the agent or surprised Bug Me without saying why, it asks: **"What made you go against the agent?"**
5. **Dispatch** goes the other way: say what you want a session to do, and Bug Me drafts a brief before it starts. The stage (prototype, MVP or product), an estimate, a stopping point at twice it where the session asks instead of growing the job, what's out of scope, the model, effort and permission mode, the tools turned off, what you must do first (a token, a decision), and what comes back to you. Sensitive work that isn't urgent is marked to run on your own machine, which the runner does (below). Copy command gives one `claude …` line with the brief as its opening prompt, and stays off until every prerequisite is ticked. Three demo tasks are recorded; on the public site the command is illustration only.
6. **Getting to know Jordan** (linked from Home) is onboarding: Bug Me reads 30 of Jordan's past decisions (made up), writes down the rules Jordan seems to follow, each with the decisions behind it, asks three questions about the rules it isn't sure of, and fixes them using the answers (DEMO REPLY gives Jordan's). Recorded, so it runs with no key. The morning itself still uses the rules Jordan wrote by hand.
7. **The clay firefly** in the corner shows the morning's glow (brighter as you give real reasons). To talk instead of type, press the microphone inside the card's text box: it keeps listening across cards, shows the words it hears under the box, and writes them into it.

Also worth a click: finish a project with Next, and the change-of-project screen may suggest a break or ask "Were those worth your time?" (times there are estimates from the route, not measured); **Your decisions** → **Weekly review sketch** draws the morning from your record against Jordan's stated priorities (synthetic); edit a written rule and watch decisions re-route; undo something in **Decided for you**, or mark it "this shouldn't have come to me"; the settings redesign card, where both options are clickable prototypes.

## What is live, what is recorded, what is code

Every card carries a badge saying where its routing came from.

| Badge | Meaning |
| --- | --- |
| **Claude, live** | A call to `claude-opus-5-5` (low effort, JSON-schema output) made just now. |
| **Claude, cached** | An earlier live answer to the byte-identical request. |
| **Claude, recorded earlier** | A live answer recorded with `npm run record` and packaged with the Worker. Replayed only on an exact request match. The opening morning (all 40 routes, briefings and option notes) and the tours' scripted reasons are recorded, so the first view is fast and costs nothing; everything a visitor types or edits goes to live Claude. |
| **code stand-in** | The deterministic keyword-matching fake (`src/shared/fakeModel.ts`), used for tests and when `FAKE_MODEL` is set. Not judgment. |

Plain code, never the model, decides: the piles, their order and the recommended one; whether a "settle" is allowed (see below); when to push back, ask why, or propose guidance (`src/shared/lifecycle.ts`); and which decisions to re-route.

When live calls are off (no key, or the daily budget is spent), only recorded answers can be evaluated. Anything else shows "couldn't evaluate", and the scripted examples offer their recorded reason behind a clearly labeled button. Nothing is silently substituted.

## How it works

```
 browser (public/, src/page/)                Cloudflare Worker (src/worker/)
 ─────────────────────────────               ───────────────────────────────────────────────
 agenda, cards, rules, record   ── /api/queue ──▶  fixtures (bundled, never served)
 (state in localStorage)        ── /api/route ──▶  routePrompt ─▶ model.ts: fake │ recorded │ cache │ live
                                ── /api/answer ─▶  unseal guess (AES-GCM, bound to decision + options + context)
                                ── /api/fact ───▶  factPrompt ─▶ proposed guidance + decisions to re-route
                                ── /api/converse ▶ conversePrompt ─▶ Bug Me's next turn and what it heard; advance() decides
                                ── /api/ask ────▶  askPrompt ─▶ an answer from the agent's context, or what is missing
                                                   SpendCounter Durable Object: reserve before each live call
```

- **Converse** (stage 6) reads the whole conversation each turn and returns Bug Me's reply and its current reading of it: the choice (an option, another course, a rejected question, or none), the why, conditions, questions with answers from the agent's material, and feedback on the question itself, each quote checked against the turn it came from. `advance` (`src/shared/converse.ts`) then decides: at most two questions, never one the thread has no room to answer, and always a read-back before anything closes; a "yes" closes only the exact decision that was read back. Claude Haiku 5.5 gives each decision an emoji, a short title and past-tense "done" lines, for display only.
- **Four prompts** (`src/shared/prompts.ts`), ported from the question critic and person model in the research behind the proposal. *Route* returns the route, a headline, a two-sentence briefing and, per option, up to two pros, two cons and a consequence, all in the person's terms; the rule or fact it turned on (quoted exactly); a calibrated guess per option; options that contradict the person's record; and what each option tells the asking agent. *Fact* turns a stated reason into new guidance, a replacement for an existing fact, or "nothing durable". *Ask* answers a clarifying question only from what the agent provided, or says what is missing. *Parse* reads the person thinking out loud and returns their choice (an option, something else, or none yet) and marks, each `{kind, quote}` with kind choice, why, but or ask; code keeps a mark only if its quote is a literal substring of the words. It has its own prompt version, so changing it leaves the other recordings valid.
- **Structured output, constrained per decision.** Each routing request carries a JSON schema built for that decision: every field that names an option is an enum of its keys, and the per-option notes are an object with a required entry for each option. With free strings, about one live answer in seven named options by their label or skipped an option; the schema makes both impossible. Code then validates every answer before it is shown, cached or recorded.
- **The settle invariant is code, and it checks less than it may sound like.** Bug Me settles alone only what is reversible, cheap, and cleared by a written rule. Code accepts the model's "settle" only when four things hold:
  - the chosen option is within its limits;
  - the clearing rule is the exact text of a current rule;
  - no rule reserves this kind of decision for the person;
  - no standing preference bears on it.

  Otherwise it brings the decision to the person and says why. In the recorded run, Claude tried to settle the $212 6:05am flight under "book the cheapest reasonable option", and code brought it back. Every quote is checked against the current rules and facts, and a quote that doesn't occur is dropped. What is and isn't guaranteed:
  - **Checked by code:** a quoted rule exists word for word; the option's cost and reversibility are within the limits; a reserving rule or a bearing preference blocks settling.
  - **Not checked:** that the rule actually authorizes this action. That is the model's reading of natural language (`src/shared/route.ts`, `enforceSettleInvariant`).
  - **Where the limits come from:** in the demo, every option's cost and reversibility are hand-written and conservative. On the live queue they are what the asking agent declares, so they are claims, not verified facts.
  - **What v1 would add:**
    - Permissions held outside the model: an allow-list per action type and project, so a rule maps to the tool calls it permits rather than to its words.
    - Reversibility taken from the action itself, not the agent's word: a branch or worktree write, a staging deploy, a held external action.
    - A spend ceiling enforced where the money moves.
- **Hidden guesses.** The guess, conflicts and send-down text are sealed with AES-GCM (fresh nonce, bound to the decision id, its options and the rules/facts version) before they reach the page. `/api/answer` opens them only for a valid choice. This prevents disclosure before the answer in ordinary use; with a public repo and a stateless endpoint it is not an adversarially blind experiment.
- **Cost controls.** Exact-match recorded runs and a response cache first; then a Durable Object that atomically reserves a worst-case charge per live call against a daily cap (`DAILY_SPEND_CAP_USD`), reconciled to actual usage; explicit `max_tokens`, a timeout and no automatic retries; only known decision ids; bounded request sizes and re-route fan-out. Every number is in `src/shared/constants.ts` with its source.

## Does a captured reason actually move the routing?

`npm run eval` asks live Claude, three fresh times per condition (no cache, no recorded answers), whether a reason the person gave changes how the decisions it should touch are routed, and leaves the others alone. Expected outcomes were written before running; the command fails unless every condition passes every trial. Latest run, 2026-10-12, on prompt version 2026-10-09.6 and the 40-question morning (`results/captures/eval-2026-10-12T13-12-05-069Z.json`, $0.96):

| Condition | Expected | Passed |
| --- | --- | --- |
| Berlin sync, default facts | a quick check for Jordan, not accepted alone (a meeting is hard to undo); guess leans accept | 3/3 |
| Berlin sync, after the flight reason | not settled; guess favors declining; quotes the newly kept fact | 3/3 |
| Berlin sync, after a *paraphrased* flight reason (whole loop) | fact proposed; not settled; guess favors declining | 3/3 |
| Formatter run (control), after the flight reason | still settled | 3/3 |
| Webhook rename, default facts | a decision for Jordan | 3/3 |
| Webhook rename, after the API rename reason | guess favors keeping the name at 0.6 or more; quotes the newly kept fact | 3/3 |
| Free tier (control), after the API rename reason | unchanged; does not quote the new fact | 3/3 |

These are designed demonstration checks on fixtures written for the demo, not an accuracy estimate.

`npm run eval:parse` checks the parse prompt the same way: six narrations (all four kinds of mark, a bare choice, a change of mind, only weighing with a question, neither option, yes with a condition), three fresh live calls each, expectations written first. It fails unless every trial gets the choice and every expected kind of mark with no mark dropped as inexact. Latest run, 2026-10-12, prompt 2026-10-12.1: 6/6 narrations, 18/18 trials, 1.2–2.4 s per parse, $0.12 (`results/captures/eval-parse-2026-10-12T05-22-13-021Z.json`).

`npm run eval:converse` checks the conversation: ten scripted conversations (a bare pick, a full narration, a question the material answers and one it can't, "just do it", a rejected question, routing feedback, a correction after the read-back, a "Huh?" on the card, and typed confusion), three live trials each, expectations written first; every reply has at most one question, and no quote fails verification in the raw output. Latest run, 2026-10-13, prompt 2026-10-13.2 on the plain option labels (stage 6f): 10/10 conversations, 30/30 trials, $0.68 (`results/captures/eval-converse-2026-10-13T16-17-14-821Z.json`). One case was rewritten after its first run in stage 6e ("What does T-19 even mean?" asks about the agent's own term, and Claude rightly answered it from the material); see [`docs/STAGE-6E.md`](docs/STAGE-6E.md).

## Run it

Requirements: Node 22, Python 3, and [gitleaks](https://github.com/gitleaks/gitleaks) for the secret scan.

```bash
npm ci
python3 -c "import secrets,base64;print('SEAL_KEY='+base64.b64encode(secrets.token_bytes(32)).decode())" > .dev.vars
npm run dev:fake          # http://localhost:8787 on the deterministic stand-in
npm run dev               # recorded Claude runs; put your own key in .dev.vars as ANTHROPIC_API_KEY for live calls
```

Checks:

```bash
npm run typecheck && npm test   # unit tests
npm run e2e                     # Playwright: desktop, phone and 320px on the stand-in, plus every tour on a keyless server with the recorded run
python3 scripts/scan.py         # secrets, private-data denylist, data-file rule, gitleaks (fails closed)
npm run record -- --dry-run     # what re-recording would call; drop --dry-run to record (costs money)
sh scripts/install-hooks.sh     # pre-push hook: scan + tests
npm run smoke:live              # the live loop end to end on a local stand-in Worker (no key, no spend)
npm run smoke:deployed -- https://bugme.weekly.org   # after a deploy: the URL serves this commit, every question routed
```

The commit a page was built from is shown at the bottom of **Your decisions**.

## Live fire: your own sessions ask Bug Me

The public site is a simulation. The same Worker can also run a real queue for one owner ([`docs/STAGE-7.md`](docs/STAGE-7.md)): Claude Code sessions ask Bug Me through an MCP tool instead of stopping to ask you; Bug Me settles only what one of your permission-granting rules covers within $1 (the asking session declares each option's cost and reversibility, and Bug Me takes its word), and queues the rest on a private page, `/me`, where you answer with the same card and conversation. The answer, your reason and any guidance go back to the session that asked.

Setting it up (once):

```bash
# 1. Make the owner key (base64url, so it survives a URL fragment) and keep it in this shell
OWNER_KEY=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
# 2. Give it to the Worker as a secret, and to your keychain for the MCP server
printf '%s' "$OWNER_KEY" | npx wrangler secret put LIVE_TOKEN --env=""
security add-generic-password -s bugme-live -a "$USER" -w "$OWNER_KEY"
echo "Sign-in link: https://bugme.weekly.org/me#k=$OWNER_KEY"
# 3. Register the MCP server for every Claude Code session
claude mcp add bugme --scope user -e BUGME_URL=https://bugme.weekly.org -- node ~/dev/when-to-bug-me/mcp/bugme.mjs
```

Then open the sign-in link once on each device; the page trades the key for a cookie and drops it from the address bar. Without `LIVE_TOKEN`, `/me` and `/api/me/*` don't exist.

**Dispatch on `/me`** ([`docs/STAGE-8.md`](docs/STAGE-8.md)). Send Bug Me your MCP servers' and skills' names and statuses (never commands, URLs or keys), so briefs can turn tools off and flag ones that need connecting:

```bash
BUGME_URL=https://bugme.weekly.org node ~/dev/when-to-bug-me/mcp/bugme.mjs sync-catalog
```

Then draft a brief on `/me` → Dispatch, tick what it needs from you, and paste the copied command in a terminal where the work should happen. The session asks through `ask_bug_me` (linked to the brief) and reports with `report_to_bug_me` when it finishes or stops; the brief shows the report, how long since you copied it, and how many times it asked. `npm run smoke:dispatch` runs that whole loop against a local Worker with a real Haiku session (about a cent).

## Mirror your terminal questions (hooks)

Best-effort mirroring of Claude Code questions and plan approvals on configured machines ([`docs/STAGE-10.md`](docs/STAGE-10.md), 10d). When a session asks you something (AskUserQuestion) or asks to go ahead with its plan (ExitPlanMode), the question also shows on `/me` under "In your sessions", briefed and routed, marked **Answer it in the session**. You still answer in the terminal; Bug Me records your answer when the session reports it, and notes what it would have done. It never answers, settles or sends anything down for a mirrored question.

What leaves the machine: the session id, the tool call's id, the project folder's name, and each question's text, header and options (with your answer, afterwards). Never the conversation, the transcript, the plan's text or the folder's path. A plan approval shows as "Approve this session's plan?" and nothing more.

Add this to the `hooks` in your `~/.claude/settings.json` (merge with any you have; it uses the same keychain entry as the MCP server):

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "AskUserQuestion|ExitPlanMode", "hooks": [{ "type": "command", "command": "BUGME_URL=https://bugme.weekly.org node ~/dev/when-to-bug-me/mcp/bugme-hook.mjs", "async": true }] }],
    "PostToolUse": [{ "matcher": "AskUserQuestion|ExitPlanMode", "hooks": [{ "type": "command", "command": "BUGME_URL=https://bugme.weekly.org node ~/dev/when-to-bug-me/mcp/bugme-hook.mjs", "async": true }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "BUGME_URL=https://bugme.weekly.org node ~/dev/when-to-bug-me/mcp/bugme-hook.mjs", "async": true }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "BUGME_URL=https://bugme.weekly.org node ~/dev/when-to-bug-me/mcp/bugme-hook.mjs", "async": true }] }]
  }
}
```

`async` keeps the hook off the session's path entirely; the script also gives up on its own after 2 seconds, prints nothing and always exits 0. Stop and SessionEnd send only the session id: a dismissed question or a rejected plan sends no follow-up event, so it closes when the session moves on ("Closed: the session moved on"), or after 18 hours with nothing. It posts wherever `BUGME_URL` points, with the `bugme-live` keychain key, so a runner it points at must use that same owner key. `BUGME_HOOK_DEBUG=1` prints why a delivery failed. `npm run smoke:live` runs the script against a local Worker.

## The runner: Bug Me on your own Mac

`npm run runner` runs the same Worker on your Mac, owner-only, behind a small front server on `127.0.0.1:8790` ([`docs/STAGE-9.md`](docs/STAGE-9.md)). Briefs and asks stay on the Mac: Bug Me drafts and routes with your own Claude Code login (`claude -p` in safe mode, with no transcript kept), so nothing goes through Cloudflare. Claude still sees what it works on, as in any session.

- **Launch.** Tick what a brief needs from you, pick a repo, and Launch. That starts `claude --bg --worktree bugme-<brief>` in that repo, with the brief's model, effort, permission mode and tools, and with Bug Me's server pointed at the runner. The brief then says how the session is doing: working, waiting on you in Bug Me, needing you in Claude (`claude attach <id>` to open it), or reported. A launch happens once, however many times it's pressed.
- **How?** Every "You first" item can show short numbered steps; on the runner, **Do it with me** opens Terminal on the Mac with a Claude in Chrome session that points the way and stops before anything secret.
- **From your phone.** Run `tailscale serve --bg 8790`, put the tailnet name in `~/.bugme/runner.env` as `BUGME_TAILNET_HOST`, restart, and open the sign-in link from `npm run runner -- --link`.
- **Repos.** Launch lists the git repos directly under `~/dev`. Claude Code must trust a repo before it can launch there: run `claude` in it once.

**Onboarding on your own history** ([`docs/STAGE-10.md`](docs/STAGE-10.md), runner only): draft your own "how to work with me" note from your past decisions. Rows come from a transcript extractor (one JSON object per question); only projects on your allow list (the file that decides which projects may reach a model at all) are read, and `private/onboard-deny.txt` (gitignored) can exclude more:

```bash
npm run onboard -- --allow <allow-list.json> <rows.jsonl>   # the newest 200 answered questions, to the runner only
```

Then open `/me#/welcome` on the runner, do the interview, and press **Keep it**: the lines become facts you can edit in Rules, and your note. The hosted site refuses this; nothing is cached, recorded or logged.

`npm run smoke:runner` runs the whole loop with the real CLI in `~/dev/bugme-sandbox` (setup at the top of `scripts/smoke-runner.ts`): draft, launch, ask, your answer, report.

## Limitations

- **The evidence boundary.** In the research behind the proposal, a check that quotes the person's written rules, ordering with reasons, and hidden guesses all worked; and with one deciding fact supplied, Opus 5.5 got 11 of 17 previously missed decisions right, against 0 without it. Nothing measured shows that a model can predict when a person will reject a strong agent's recommendation. The MVP does not claim it.
- One synthetic persona and a fixed set of 40 decisions; no real agents, intake or send-down.
- Visitor state lives in the browser only. The record can be exported as JSON.
- Re-routing after kept guidance checks decisions that share a topic tag with the answered one plus the model's suggestions, capped; it can miss a decision that shares neither.
- Voice uses the browser's speech recognition (Chrome, Safari); in Chrome the audio goes to the browser's speech service, which the page says beside the firefly. Typing always works.
- Answers, guidance and set-asides are simulated: nothing reaches a real agent, and "Ask the agent" gathers nothing new.

## How this was built

Designed by David E. Weekly, built with Claude Code (Claude Opus 5.5) as the implementing agent, from a written product proposal and a plan per stage. Each plan was reviewed once by OpenAI Codex before building, and every diff by Codex before merge. Design changes went through quick mockups first (two versions each of Home and the decision card, picked by David) before any code. Claude Code wrote the code, fixtures and tests; subagents built the two settings prototypes, the secret scanner and CI, and test suites in parallel. Each recorded run was made against the live API for about a dollar.

See also: [`ROADMAP.md`](ROADMAP.md) (fresh as of 2026-10-11), [`CHANGELOG.md`](CHANGELOG.md) (fresh as of 2026-10-11), [`CLAUDE.md`](CLAUDE.md) (guardrails for agents working here).

## Documents

Each entry says what the document holds, when it last changed, and the trigger that would bring
someone back to it. The stage files are the record of what was built and why, in order; they are
not revised once their stage merges, so a stage's current behaviour lives in the code and in
`CHANGELOG.md`.

- [CLAUDE.md](CLAUDE.md): how to work in this repo — what Bug Me is, the commands that must pass, the data rules, and the guardrails an agent must not quietly relax. (updated 2026-10-16; update when: a command, convention or guardrail changes)
- [ROADMAP.md](ROADMAP.md): stack-ranked work after the prototype, including concerns raised in review that belong outside the current effort. (updated 2026-10-16; update when: an item lands, or a new concern is deferred out of the current effort)
- [CHANGELOG.md](CHANGELOG.md): what shipped, newest first. (updated 2026-10-14; update when: anything ships)
- [docs/BUILD-PLAN.md](docs/BUILD-PLAN.md): the PRD and sequenced plan for the hosted prototype — the first stage of the MVP, with its pass-or-fail commands. (updated 2026-10-09; update when: a new stage is planned or the prototype's scope changes)
- [docs/STAGE-2.md](docs/STAGE-2.md): home and focus views, "not now", the guided tours and the explainer page. (updated 2026-10-09; update when: that stage's behaviour changes)
- [docs/STAGE-3.md](docs/STAGE-3.md): piles on Home, the decision card, answer types and always-on voice. (updated 2026-10-11; update when: that stage's behaviour changes)
- [docs/STAGE-4.md](docs/STAGE-4.md): think out loud — one place to talk a decision through, marked up as Bug Me reads it, after a review found the card mixed directions. (updated 2026-10-11; update when: that stage's behaviour changes)
- [docs/STAGE-5.md](docs/STAGE-5.md): the fixture rewrite that made the demo morning match the proposal — 40 questions raised, 31 settled, 9 waiting. (updated 2026-10-12; update when: the morning's fixtures or the proposal's numbers change)
- [docs/STAGE-6.md](docs/STAGE-6.md): the decision as a conversation — Bug Me opens, the person talks back, and nothing closes without a read-back. (updated 2026-10-13; update when: that stage's behaviour changes)
- [docs/STAGE-6E.md](docs/STAGE-6E.md): "Huh?" — one press that makes Bug Me say the card again in plain English and counts it as a miss on its own translation. (updated 2026-10-13; update when: that stage's behaviour changes)
- [docs/STAGE-6F.md](docs/STAGE-6F.md): the card in Jordan's words, and where the "Huh?" control belongs. (updated 2026-10-14; update when: that stage's behaviour changes)
- [docs/STAGE-7.md](docs/STAGE-7.md): live fire — real Claude Code sessions asking through MCP instead of stopping, answered on a private owner page. (updated 2026-10-12; update when: the live queue, the MCP tools or the owner page change)
- [docs/STAGE-8.md](docs/STAGE-8.md): Dispatch — sizing and briefing a task before the session starts, with what the person must do first. (updated 2026-10-13; update when: Dispatch's brief or prerequisites change)
- [docs/STAGE-9.md](docs/STAGE-9.md): the runner — starting dispatched work on your own machine rather than handing over a command to paste. (updated 2026-10-14; update when: the runner's behaviour or setup changes)
- [docs/STAGE-10.md](docs/STAGE-10.md): closing the gaps before pencils down — the four differences between what the demo did and what a release would do, and which were closed. (updated 2026-10-14; update when: one of the remaining gaps is closed)
- [docs/STAGE-11.md](docs/STAGE-11.md): answering a reviewer who read the whole submission on 2026-10-14 — which of their points were taken, and what was declined. (updated 2026-10-14; update when: another full review arrives)
