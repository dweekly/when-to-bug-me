# Stage 8: Dispatch

## Why

David, 2026-10-13: before work starts, size the task and set it up properly:
- the right context;
- the right tools, skills, plugins and MCPs;
- the right model, effort and speed;
- explicit direction on how much time and budget the work has.

Agents rabbit-hole. "A quick demo or a lightweight prototype ends up getting turned into a ridiculously overengineered production system." Some tasks also need the person first: a new API token, or permissions granted in advance. Sensitivity matters as well as size: work that isn't urgent but is sensitive can run locally, so the data never leaves the machine.

So far Bug Me covers one direction, questions coming up from the fleet (Respond). Dispatch covers work going down to it. It is one of the four loops (Imagine, Dispatch, Respond, Reflect) in the proposal's notes.

David's decisions (2026-10-13):
- **Output:** a brief plus a command to copy and run. No launcher.
- **Local route:** recommended only, not wired.
- **Demo:** a Jordan demo on the public site with recorded examples.
- **Report-back:** a simple one at the end of the task.

The intent: a rough task, said or typed, becomes a brief and a ready `claude` command. The command runs the work at the right size, with the right model, effort and tools, and with a tripwire that comes back to Bug Me as a question rather than as a bigger system. When the task ends, the session reports how it went next to what was briefed. Another design that does that with fewer moving parts would also serve.

## What changes

### The brief (the model drafts, code decides)

`POST /api/dispatch` (public world) and `POST /api/me/dispatch` (owner) take `{task, answers?}` and return a brief.
- **Model:** Opus 5.5, structured output.
- **Schema:** built per request. Fields that name a model, effort, permission mode, tool or skill are enums from the catalog, so a brief can't name a tool that isn't installed.
- **The brief's fields:**
  - `headline` (≤ 8 words), `goal`, `why`;
  - `questions`: at most 3, and only ones whose answer would change the brief (asking everything up front);
  - `stage`: prototype, mvp or product; `done` (≤ 3 checks); `out_of_scope` (≤ 4);
  - `estimate_minutes`, `budget_usd`;
  - `model`, `effort` (low to max), `permission_mode` (`plan`, `manual`, `acceptEdits` or `auto`; never `bypassPermissions` or `dontAsk`);
  - `sensitivity` and `urgency`: low, medium or high, each with a short reason;
  - `tools_off`: MCP servers the task shouldn't touch; `tools_needed`: ones it must have; `skills`: skills worth loading;
  - `context` (≤ 5 pointers);
  - `guidance`: the person's rules and facts that bear on the task, quoted exactly;
  - `prerequisites` (≤ 4, each `{what, why}`);
  - `check_ins` (≤ 4 decisions that must come back through Bug Me).

**Code decides:**
- **Quotes:** a quote that isn't an exact substring of a current rule or fact is dropped, as in routing.
- **Where it runs** follows a table, not the model:
  - high sensitivity and low urgency: run locally (recommended only; not wired);
  - high sensitivity otherwise: run in the cloud, with a check-in added before anything sensitive leaves the machine;
  - everything else: run in the cloud.
- **The tripwire** is `TRIPWIRE_MULTIPLE` = 2 × the estimate and the budget. Its sources are Jordan's R10 and David's CLAUDE.md ("past twice its time budget").
- **The command** is built from the fields, with every argument single-quoted:
  ```
  claude --model '<id>' --effort '<e>' --permission-mode '<m>' [--disallowedTools 'mcp__<server>' …] "$(cat <<'BRIEF_<n>'
  …brief text…
  BRIEF_<n>
  )"
  ```
  - The heredoc delimiter is chosen so that it doesn't occur in the text.
  - Values are enums, and server prefixes were validated when they came in (`^mcp__[A-Za-z0-9_-]{1,80}$`). They are quoted anyway. The brief text sits inside the quoted heredoc, so nothing in it expands.
  - Unit tests run the built command through `zsh -c` against a stub `claude` that prints its argv. Hostile brief text and catalog names (`$(…)`, backticks, quotes, a line equal to the delimiter) come out as literal arguments.
  - When the recommendation is local, the page offers the brief to copy and labels the command "Run in the cloud anyway".
  - **On the public site the command is illustration only.** Jordan's tools are synthetic, and report-back needs the owner's credentials, so it isn't offered there.
- **The brief text** is the session's opening prompt. It holds:
  - the brief id, goal and why, stage, done-when and out of scope;
  - the time tripwire: "Run `date` now. At N minutes (2× the estimate), stop and use ask_bug_me before continuing: say what's left and offer smaller versions";
  - the dollar budget as a guide only: a session can't read its own spend;
  - the tools it needs, and the skills worth loading, as instructions;
  - context, guidance and the check-ins (via ask_bug_me, passing the brief id);
  - "When you finish or stop, call report_to_bug_me with brief <id>."
- **`--max-budget-usd` is not used.** It only works with `-p` (`claude --help`, 2.1.296), and a dispatched session is interactive. The dollar figure is advisory. The tripwire that can actually be kept is time. A hard cap for headless runs is on the roadmap.

### The catalog

- **What it is:** what a brief may choose from: models (constants: Opus 5.5, Sonnet 5.5, Haiku 5.5), effort levels, permission modes, MCP server names, skill names.
- **Public world:** `fixtures/catalog.json`, Jordan's synthetic tools.
- **Owner world:** `node mcp/bugme.mjs sync-catalog` sends each MCP server's name, tool prefix and status (connected, needs authentication, failed or not configured) from `claude mcp list`, plus skill names from `~/.claude/skills/*`. It never sends commands, env or URLs. They go to `POST /api/me/catalog` and are stored in `OwnerQueue`.
  - The tool prefix is Claude Code's: the name with every character outside `[A-Za-z0-9_-]` replaced by `_` (`claude.ai Gmail` → `mcp__claude_ai_Gmail`, matching the tool names a session sees).
  - The Worker rejects any prefix or skill name that fails its pattern.
  - Without a catalog, owner briefs pick models and effort but name no tools.
- **Statuses are taken at face value only as hints.**
  - A server in `tools_needed` that isn't connected becomes a prerequisite ("Connect Sentry: needs authentication").
  - Bug Me's own server is required on every owner brief and can never be turned off (code drops it from `tools_off`).
  - If Bug Me's server isn't connected, that is the first prerequisite.

### What it learns from (report-back)

- **A new MCP tool, `report_to_bug_me({brief, outcome, scope, summary, cost_usd?})`:**
  - `outcome`: done, stopped at the tripwire, partial or abandoned;
  - `scope`: as briefed, smaller or bigger.
- **The Worker stores it with the brief and measures two things itself:**
  - minutes since the brief was copied, labeled exactly that (the page posts `dispatched` with the final fields when Copy is pressed; a later copy replaces it);
  - how many times the session asked through `ask_bug_me`, which gains an optional `brief`.
- **Whether the tripwire was hit** comes from the reported outcome, not from the clock.
- **Cost is reported by the session only if it knows it, and shown as "not reported" otherwise.** A session can't read its own spend today; reading it from the transcript is on the roadmap.
- **Owner data stays in `OwnerQueue` (`brief:` keys)** and is never cached or recorded, as with tickets.
  - `dispatchFor` takes its context with no default, so a caller has to say which world it is in.
  - A unit test drafts an owner brief containing a sentinel. It checks that the cache and the recorded run are never read or written, and that the error log never contains the sentinel.

### The page

- **A Dispatch view in the nav:**
  - the text box with the microphone;
  - on the public site, three DEMO chips;
  - the briefs so far: localStorage on the public site, `OwnerQueue` on `/me`.
- **The brief card:**
  - the headline, and a line of symbols: stage · ~N min · $X · 2× tripwire;
  - where it runs (model · effort · permission · cloud or local, with the reason when local);
  - goal and why; done when; out of scope; tools off, as toggles; skills;
  - your rules that apply (quoted);
  - before it starts: prerequisites as checkboxes;
  - what comes back to you.
- **Questions** sit above the card with one answer box. Redraft sends the task plus the answers.
- **Edits:**
  - model, effort, minutes, dollars and tool toggles are editable;
  - the command rebuilds as you edit (the builder is shared code);
  - **Copy command** stays off until every prerequisite is ticked; **Copy brief** is always on.
- **A report**, when there is one, shows:
  - the outcome;
  - minutes vs. the estimate, and whether the tripwire was hit;
  - how many times it asked you;
  - the cost, or "not reported";
  - the summary.
- **On `/me`:** a hint under the box: "Describe the task, not the sensitive data" (drafting is a cloud call).

### The Jordan demo

Three recorded examples:
1. **"Spin up a quick demo of the usage dashboard for Thursday's review":** a prototype with a tight out-of-scope list (no auth, no tests beyond one smoke run), low effort, a small budget.
2. **"Go through last quarter's support tickets and find the billing complaints":** high sensitivity, low urgency, so code recommends running locally; Slack and email tools off.
3. **"Hook the release bot up to PagerDuty":** a prerequisite, a PagerDuty API token granted up front, and a check-in before anything pages a person.

The first carries a synthetic report, labeled synthetic like everything else: done at 38 minutes vs. 30, asked once, scope as briefed. A Dispatch demo in the Demos menu walks through it.

## As built

- **The recorded demo briefs read like briefs** (Opus 5.5, 2026-10-13, $0.11 for the three):
  - the dashboard demo is a prototype, with eight tools turned off;
  - the support tickets are high sensitivity and low urgency, so code says run locally;
  - the PagerDuty hookup asks up front for the integration key and for which releases should page, and gives three check-ins.

  Claude picked Sonnet 5.5 for all three; Jordan has no rule about models.
- **`--` before the brief.** `--disallowedTools` takes several values, so without `--` it swallowed the opening prompt as tool names. Codex found it, and Claude Code 2.1.296 confirmed it ("Permission deny rule "Reply" matches no known tool"). `smoke:dispatch` now turns a tool off, so the real-CLI gate covers that path.
- **The person's own words go to the session.** The brief summarizes the task; the opening prompt also carries the task and any answers verbatim, trimmed but with their whitespace intact.
- **Real sessions behave.** In `smoke:dispatch`, a Haiku session started from a generated command:
  - asked once through `ask_bug_me` with the brief's id;
  - wrote its one file;
  - reported back, about $0.01 a run.

  Twice, with the stand-in's vague "runs from one command" check, it reported "partial" and said why, instead of claiming done.
- **The first request after a session's run can hit a dropped connection** on the local Worker. One retry succeeds, which says the Worker was alive (seen every run on 2026-10-13, never twice in a row).
- **The Dispatch demo** ("Send work out at the right size") runs start to finish on the recorded run at desktop and phone widths. Its first popover sits above the box, because on a phone it covered Draft brief.
- **Questions are a conversation** (David, 2026-10-13: a question box on top of the card with a Redraft button "is a little silly"). The task and answers show as the person's turns, Bug Me asks under them, and Send redrafts. Every answer so far goes along, so a second round of questions doesn't drop the first.
- **Copy on `/me`** calls the clipboard inside the click, with a promise that resolves once the save lands, because Safari refuses a clipboard write made after an await. Only the clock comes back from the save, so edits made meanwhile stay.
- **Review decisions (David, 2026-10-13):**
  - #36 (engine): merge after the round-2 fixes, with no third round;
  - #37 (page): Codex escalated after round 2 with three bugs, all fixed (answers across redrafts, the Safari clipboard, the save overwriting edits); merge, then plan stage 9.
- **The card, redesigned** (David, 2026-10-13: "way way too verbose", the bold white text was hard to read, the repeated ✕ hurt scanning).
  - One prompt: "What do you want done?".
  - The card reads top to bottom:
    - the title and a line of chips (stage, time with its stopping point, money, cloud or local);
    - the goal;
    - checks;
    - what's out, as one muted line;
    - "You first" (the one block in the accent);
    - what comes back to you.
  - Model, effort, mode, time, money, tools, the quoted rules, the source label and the command sit behind Details.
  - Text is regular weight in muted ink, and color is only on icons.
  - The prompt (2026-10-13.2) asks for sticky-note-length items, and code drops a prerequisite that repeats connecting a server already listed. Re-recorded for $0.09.
- **Next (stage 9):** a local runner reached over localhost or Tailscale.
  - It starts the session itself, reads the tools live and makes the worktree.
  - "Walk me through it" on each prerequisite: at least step-by-step instructions, at best a Claude session that drives Chrome with the person.
- - **Spend:** about $0.17 in all (the recording, plus about a dozen cent-sized CLI checks).

## Gates

```bash
npm run typecheck && npm test
# brief parse:   enums enforced, quotes dropped when not exact
# where it runs: the sensitivity × urgency table
# command:       built from fields, heredoc delimiter never in the text, no bypass modes
# report:        parse and limits
# recorded:      the recorded briefs match the prompt

npm run e2e
# fake model: Dispatch view; a DEMO chip → brief; Copy command is off until prerequisites are ticked;
# editing the model or effort changes the command; questions → Redraft;
# report shown; no horizontal scroll at 320px

npm run e2e -- --project=recorded-desktop --project=recorded-phone
# the three examples render from recordings; the local example shows "Run in the cloud anyway"

npm run smoke:live
# extended: sync-catalog, dispatch, dispatched, report_to_bug_me and an ask with a brief id,
# against wrangler dev with LIVE_TOKEN; the brief shows the report and one ask

npm run smoke:dispatch
# NEW, real CLI (cents): drafts a brief on wrangler dev (fake model, LIVE_TOKEN set) for a tiny synthetic
# task. Runs its generated command with Haiku, -p appended, and --mcp-config pointing Bug Me's server
# at the local Worker. Asserts the stored brief has a report from that session and a ticket carrying its brief id.

python3 scripts/scan.py
```

**Checked already (2026-10-13, Claude Code 2.1.296):**
- Headless with Haiku, `--disallowedTools mcp__todoist` leaves every Todoist tool out.
- Without the flag, they are listed.

**Re-record:** the three briefs (Opus, about $0.30).

## Out of scope

- A launcher: worktree creation or starting the session for you.
- A real local-model route (Ollama is installed on David's laptop, but not running and with no models).
- Measuring cost from transcripts.
- Hard budget caps for interactive sessions.
- Handing off from phone to laptop beyond the clipboard (Universal Clipboard covers copying on the phone and pasting on the Mac).
- Calibrating estimates from past reports. Elapsed time since copy isn't work time, so reports are shown, not learned from yet.
- Imagine and Reflect.

## PRs

- **8a, the engine:** shared brief, schema, command builder, Worker routes and storage, MCP tools, fake stand-in, unit tests.
- **8b, the page:** the page, the demo and recordings, e2e, docs.

Each PR stays under the review cap.

## Codex plan review (gpt-6.1-sol, high, 2026-10-13)

**Folded in:**
- **Shell injection:** every argument is quoted, prefixes and skills are validated when they come in, and an argv-capture test uses hostile values.
- **Owner privacy:** `dispatchFor` has no default context; a sentinel test covers cache, recorded run and logs.
- **Public commands are illustration only;** report-back is owner only.
- **Capabilities:**
  - statuses come in with the catalog;
  - Bug Me's server is required and can't be turned off;
  - needed tools and skills are written into the brief text.
- **Dollars are advisory;** the tripwire is time.
- **A real-CLI gate,** `smoke:dispatch`, runs a generated command to a stored report and a linked ticket.
- **Labels:** "minutes since copied"; tripwire status from the reported outcome; no calibration from it.
- **The scan:** the plan named a private repo and machine; removed. The full scan, including the private denylist, also found two private project names in `tests/unit/live.test.ts` (from stage 7); replaced with synthetic ones.
- **Calibration** is cut.

**Declined:**
- **Fixed model and effort only.** Choosing them is the point of the feature, and both are enums.
- **Dropping skill discovery.** It's a directory listing of names.

## Questions for David

- **History:** the stage 7 commit (197a19e) has two private project names in `tests/unit/live.test.ts`. They are removed going forward but remain in history. Rewrite history before the repo goes public, or accept them?
