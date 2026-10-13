# Stage 8: Dispatch

## Why

David, 2026-10-13: before work starts, size the task and set it up properly:
- the right context;
- the right tools, skills, plugins and MCPs;
- the right model, effort and speed;
- explicit direction on how much time and budget the work has.

Agents rabbit-hole. "A quick demo or a lightweight prototype ends up getting turned into a ridiculously overengineered production system." Some tasks also need the person first: a new API token, or permissions granted in advance. Sensitivity matters as well as size: work that isn't urgent but is sensitive can run locally, so the data never leaves the machine.

So far Bug Me covers one direction, questions coming up from the fleet (Respond). Dispatch covers work going down to it. It is one of the four loops in `labs-takehome/docs/product/FOUR-LOOPS.md`.

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
- **The command** is built from the fields:
  ```
  claude --model <id> --effort <e> --permission-mode <m> [--disallowedTools mcp__<server> …] "$(cat <<'BRIEF_<n>'
  …brief text…
  BRIEF_<n>
  )"
  ```
  - The heredoc delimiter is chosen so that it doesn't occur in the text.
  - Every value is from an enum, except the brief text, which sits inside the quoted heredoc.
  - When the recommendation is local, the page offers the brief to copy and labels the command "Run in the cloud anyway".
- **The brief text** is the session's opening prompt. It holds:
  - the brief id, goal and why, stage, done-when and out of scope;
  - the budget and tripwire: "At $X or N minutes, stop and use ask_bug_me before continuing: say what's left and offer smaller versions";
  - context, guidance and the check-ins (via ask_bug_me, passing the brief id);
  - "When you finish or stop, call report_to_bug_me with brief <id>."
- **`--max-budget-usd` is not used.** It only works with `-p` (`claude --help`, 2.1.296), and a dispatched session is interactive. The budget is enforced by the tripwire instruction, and a hard cap for headless runs is on the roadmap.

### The catalog

- **What it is:** what a brief may choose from: models (constants: Opus 5.5, Sonnet 5.5, Haiku 5.5), effort levels, permission modes, MCP server names, skill names.
- **Public world:** `fixtures/catalog.json`, Jordan's synthetic tools.
- **Owner world:** `node mcp/bugme.mjs sync-catalog` sends names only (from `claude mcp list` and `~/.claude/skills/*`; never commands, env or URLs) to `POST /api/me/catalog`, which is stored in `OwnerQueue`. Without a catalog, owner briefs pick models and effort but name no tools.

### What it learns from (report-back)

- **A new MCP tool, `report_to_bug_me({brief, outcome, scope, summary, cost_usd?})`:**
  - `outcome`: done, stopped at the tripwire, partial or abandoned;
  - `scope`: as briefed, smaller or bigger.
- **The Worker stores it with the brief and measures two things itself:**
  - minutes since the brief was copied (the page posts `dispatched` with the final fields when Copy is pressed);
  - how many times the session asked through `ask_bug_me`, which gains an optional `brief`.
- **Cost is reported by the session only if it knows it, and shown as "not reported" otherwise.** A session can't read its own spend today; reading it from the transcript is on the roadmap.
- **Owner drafts include the last 5 reports** (headline, estimate vs. actual minutes, outcome, scope), so estimates calibrate against how the person's tasks actually went.
- **Owner data stays in `OwnerQueue` (`brief:` keys)** and is never cached or recorded, as with tickets.

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

python3 scripts/scan.py
```

**Plus two checks of the real CLI (cents):**
- A command built for a test brief, with `-p "Reply OK"` appended, runs and replies.
- `--disallowedTools mcp__<server>` leaves that server's tools out, checked headless with Haiku.

**Re-record:** the three briefs (Opus, about $0.30).

## Out of scope

- A launcher: worktree creation or starting the session for you.
- A real local-model route (Ollama is installed on monster4, but not running and with no models).
- Measuring cost from transcripts.
- Hard budget caps for interactive sessions.
- Handing off from phone to laptop beyond the clipboard (Universal Clipboard covers copying on the phone and pasting on the Mac).
- Learning beyond feeding recent reports into the draft.
- Imagine and Reflect.

## PRs

- **8a, the engine:** shared brief, schema, command builder, Worker routes and storage, MCP tools, fake stand-in, unit tests.
- **8b, the page:** the page, the demo and recordings, e2e, docs.

Each PR stays under the review cap.
