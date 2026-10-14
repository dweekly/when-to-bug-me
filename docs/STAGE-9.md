# Stage 9: the runner

## Why

Stage 8 turns a rough task into a brief and a `claude` command, then stops: the person copies the command, makes a worktree, and starts the session themselves. "You first" steps (connect PagerDuty, get a token) are a checklist with no help doing them.

David, 2026-10-13 and 2026-10-14:
- Bug Me should be able to run on your own machine, reachable on localhost or over Tailscale, and launch the work itself.
- Before work starts, Bug Me should help the person through the steps that are theirs, "using a Claude Chrome session to help guide them, or at the very least helping walk them through what needs to be done and how".
- It follows the stage 8 routing note: work that isn't urgent but is sensitive can stay on the machine.

David's decisions (2026-10-14):
- **The runner serves the page.** One local process serves the same Bug Me page and API on localhost, and David reaches it from his phone with `tailscale serve`. The runner drafts with the person's own Claude Code login, so its briefs never pass through Cloudflare. The hosted site stays the public demo.
- **Sessions are attachable.** One interactive session per brief, in its own git worktree, that the person can open from a terminal.
- **Walk me through it:** short numbered steps for every "You first" item, on both the hosted and the runner page. On the runner, "Do it with me" also starts a Claude in Chrome session on the Mac that points the way.
- **One machine.** The Mac the runner is on. Other machines go on the ROADMAP.

The intent: from a phone or the laptop, a ticked brief becomes a running session in one tap, sized as briefed, asking and reporting back to the same Bug Me. Another design that does that with fewer moving parts would also serve.

**What "local" means here.** On the runner, Bug Me's storage and the work itself stay on the Mac and never touch Cloudflare. Claude still receives the model input, as it does in any Claude Code session. A fully local model is on the ROADMAP. The page's labels say this plainly:
- "🔒 local" for a sensitive brief means "runs on this Mac, and Claude sees it";
- the reason text stops promising a local model.

## What changes

### The runner (`npm run runner`)

A Node process on the Mac, with everything it owns bound to `127.0.0.1`. It is owner-only: no public world, no demo.

**The Worker, unchanged, underneath.**
- Started with `wrangler dev --ip 127.0.0.1`, as `smoke:live` and `smoke:dispatch` already do, with its inspector off.
- Persists to `~/.bugme/state`, outside the repo.
- Its secrets (seal key, owner token, model-callback token) are generated on first run into `~/.bugme/runner.env` (mode 0600) and passed with `--env-file`, never on a command line.
- Startup:
  - build the page, start the Worker and wait until it answers, then listen;
  - read the catalog in the background; if the read fails, say so and keep the last catalog.
- Exit: stop the Worker and any helper processes. Launched work sessions keep running.

**A front server** on one port, in front of the Worker. Its guards:
- **`Host`:** must be `localhost` or `127.0.0.1` on the runner's port, or the tailnet name set in `runner.env`. An exact match, so a hostile suffix or DNS rebinding fails.
- **Owner only:** every request needs the owner's session (the cookie, checked by asking the Worker), except:
  - the page's static files;
  - the sign-in route;
  - the model callback (below), which has its own token.
- **Public model routes** (`/api/dispatch`, `/api/fact` and the rest outside `/api/me/`) are 404, so nobody without the owner's session can spend the person's Claude login.
- **POSTs:** every browser POST needs an `Origin` that exactly matches (scheme, host and port).
- **Forwarding headers:** spoofed ones are ignored.

**Drafting on the person's Claude Code login.**
- `ask()` in `src/worker/model.ts` is the one place the Worker calls the model.
  - With `LOCAL_MODEL_URL` set, it posts `{model, effort, schema, prompt}` to the runner's `/runner/model`, which needs `LOCAL_MODEL_TOKEN`, instead of calling the API.
  - The answer passes the same validation as an API answer.
  - Done: commit 56ec356.
- The runner answers with `claude -p --safe-mode --no-session-persistence --tools "" --strict-mcp-config --model <m> --effort <e> --output-format json --json-schema <schema>`:
  - the prompt goes in on stdin, so it never appears in `ps`;
  - it runs in an empty directory;
  - it returns `structured_output`.
- What those flags do:
  - `--safe-mode` turns off the person's CLAUDE.md, hooks, skills and plugins, while their login still works;
  - `--no-session-persistence` keeps no transcript.
- No subprocess output, error or prompt is ever logged.
- At most two run at once, and each is killed at its deadline.
- Owner calls are already `store: false`, so the Worker caches and records nothing.
- The queue's `mode` / `live_available` count the runner as live.
- Checked 2026-10-14 on Claude Code 2.1.299:
  - the command returns `structured_output`;
  - with `--no-session-persistence`, no transcript is written;
  - `--safe-mode` keeps the login;
  - a Haiku call took about 2 seconds and cost $0.002.

**Deadlines line up.** One owner ask through the runner can mean two model calls, each about a minute with Opus. The MCP server's ask wait, the Worker's runner timeout and the subprocess deadline are set together in `constants.ts` (or beside the existing ones in `mcp/bugme.mjs`), each longer than what it waits on.

### Launch

On the runner, the brief's primary action is **Launch**. Copy command stays in Details.

**What the page sends:** `POST /runner/launch {brief_id, repo}`. The repo is a name from the picker, nothing else. The runner trusts nothing else from the browser.

**What the runner checks**, against the stored brief and catalog fetched from the Worker:
- **The brief:** its executable fields are re-validated (`parseEdits` and `commandArgs` already refuse anything off the enums or patterns).
- **"You first" items:** every one is acknowledged. Ticks are now saved on the brief, through the existing `/dispatched` call, so another device sees them too.
- **The repo:** it resolves to a real path under `~/dev`, from the server-side list (a git repo, no symlink escape). The runner checks trust again (reading `~/.claude.json`, never writing it), and an untrusted repo gets the fix ("run `claude` there once").
- **Tools:** the runner runs `claude mcp list` in the chosen repo. A needed tool that isn't connected there blocks launch, by name.

**One session per brief.** The launch record lives on the brief in the Worker: `launch: {state, repo, session_id?, worktree?, at}`.
- **Reservation:** a launch reserves atomically (`launching`). A second launch, from a double tap or another device, gets the existing record back.
- **Recovery:** if the runner dies mid-launch, it reconciles at startup and before any retry. It finds the session named `bugme-<id>` in `claude agents --json --all`, and either fills in the record or marks it `failed`.
- **Retries:** only a `failed` launch can be tried again.
- **Timestamps:** `launched_at` is separate from `dispatched_at` (copied), so the elapsed time is honest.

**The command**, run with `execFile` and no shell in between: `claude --bg --worktree bugme-<id> -n bugme-<id> --mcp-config <file> --allowedTools mcp__bugme <commandArgs minus "claude">`. That puts `--` and the brief last.
- **`commandArgs`** is shared with Copy command, so the two can't drift (done, with an argv test).
- **The MCP config file** (0600, in `~/.bugme`) defines only `bugme`:
  - an absolute `node` path and an absolute path to `mcp/bugme.mjs`;
  - `BUGME_URL` (the runner) and `BUGME_TOKEN`, both explicit, so it never falls back to the keychain's hosted token.
- **No `--strict-mcp-config`:** the person's other servers stay available, as the brief expects.
  - Checked 2026-10-14: a `--mcp-config` entry named `bugme` replaces the user-scope `bugme` (`source: dynamic`).
- **`--allowedTools mcp__bugme`** means asking and reporting never wait on a permission prompt. It goes into Copy command too.

**Session state on the page**, refreshed every few seconds while the page is visible and again when it regains focus. The refresh keeps unsent text, edits and focus. It combines:
- the CLI's state (`claude agents --json --all`: running, idle, done, failed or stopped);
- the brief's pending asks;
- its report.

What it shows:
- **Waiting on you in Bug Me:** a pending ask, which links to it.
- **Needs you in Claude:** the session is blocked on Claude's own prompt, so attach.
- **Working.**
- **Done:** a report came back.
- **Stopped or failed:** no report, shown as not done.

Each state shows the session's `claude attach <id>`, ready to copy. The rest of the owner page (asks, reports) gets the same refresh, because a launched session's asks have to reach the phone without a reload.

Checked 2026-10-14:
- `claude --bg --worktree <name> -n <name>` returns an id at once.
- `claude agents --json --all` reports `{id, cwd, name, status, state}`.
- `claude rm <id>` deletes the session and its worktree.
- `--bg` refuses an untrusted repo with "Workspace not trusted…". Trust is per directory: a repo under a trusted `~/dev` was refused.

### Walk me through it

Every "You first" item gets **How?**, which opens short numbered steps: at most five, each at most 140 characters, each with an optional link.

**The steps:**
- **A new model call,** `walkFor(input)`.
- **The input is canonical:** the prerequisite's text and reason, the task's headline and goal, and the names of the tools involved. No ids, timestamps, setup fields or reports, so the recordings match.
- **Checked by code:**
  - links are `https`, with no credentials in the URL, shown with their domain;
  - the steps never ask the person to paste a secret into Bug Me or a chat, only where it goes.
- **Kept on the brief,** with their source and the prompt version, and dropped when the item changes.
- **Public demo:** recorded steps for every prerequisite of the three examples, including the "Connect X" ones code adds. A test asserts that each one shown has a recording.

**"Do it with me"** (runner only) is a guide, not a doer.
- **Starting it:**
  - it writes the walk prompt to a 0600 file and a fixed `.command` script;
  - `open -a Terminal` opens it on the Mac: no AppleScript, and no step text in any command line;
  - the script runs `claude --chrome --no-session-persistence -- "$(cat <prompt file>)"`.
- **The session:**
  - first asks the person to say they're at the Mac;
  - then opens the right page and says what to click;
  - stops before any page that would show or take a secret, and hands that part back to the numbered steps.
- **The limit:** Claude in Chrome can read the page, so the boundary is where the walk stops, not a promise that it won't look.
- **When it can't run:** if Chrome or its extension isn't ready, the button says so, and How? still works.
- **Done:** the person ticks the box.

### Reaching it from a phone

`tailscale serve --bg <port>` serves the runner on the tailnet only, over HTTPS. David runs this himself, since it changes his tailnet's configuration, and puts the tailnet name in `runner.env`.

Sign-in uses the existing sign-in link. It carries a reusable owner token, so it's treated like a password. `npm run runner -- --link` prints it again without changing it.

## As built (2026-10-14)

Where the build differs from the plan above, and what it found.

- **Startup.** The runner listens as soon as the Worker answers. Reading the tools runs `claude mcp list`, which checks every server and can take half a minute, so it runs in the background; until it lands, the last catalog stays.
- **The Worker answers only through the runner.** The automated security review of 9a found that the loopback Worker could be reached directly, skipping the guards, by another local process or by a page using DNS rebinding. The runner now adds its model key in a header (`x-bugme-runner`) to every request it passes on. With `LOCAL_MODEL_URL` set, the Worker refuses anything without that header, the owner's own key included.
- **wrangler is in the runner's process group,** started directly rather than through npx. SIGTERM reaches it, and it stops workerd; a group kill (Playwright's) stops all three.
- **Waiting asks per brief.** `GET /api/me/briefs` also returns, per brief, the asks still waiting on the owner, so the brief can say "waiting on you" and link to the ask.
- **The owner page picks up new asks** (every 8 s while visible, additions only, never redrawing while something is being typed). The Dispatch view refreshes briefs and sessions on the same beat.
- **Session states** follow Claude Code's own (code.claude.com/docs/en/agent-view):
  - working;
  - blocked, which the page shows as "needs you in Claude", with its `waitingFor`;
  - done, failed and stopped.

  A pending ask on the brief comes first ("waiting on you", which links to the ask), and a report wins over everything.
- **Copy command** quotes values but not flags, as before; the shared `commandArgs` briefly quoted both, and the stage 8 e2e tests caught it.
- **Walk steps** came back with links only where the model was confident: the recorded PagerDuty steps link to `support.pagerduty.com` and `github.com`. Recording cost $0.025.
- **A test broke the main checkout's git config, once.** Inside the pre-push hook, `GIT_DIR` points at the repo. A unit test's `git init` in a temporary folder inherited it and set `core.bare = true` on the main checkout. It was restored by hand. The test and the e2e fixture now strip `GIT_*` variables, so a hook can't do this again.

**Verified:**
- `npm run typecheck && npm test`: 492 tests.
- `npx playwright test`: the full suite, with the new runner project.
- `npm run smoke:live`.
- Drafting through the real Claude login: a brief in 9 s.
- curl checks of every guard.
- Launches on the stub:
  - refused when unticked, untrusted, outside the dev folder, or missing a connected tool;
  - three presses at once start one session;
  - a failed launch is recorded and can be retried.

**Waiting on David:** `smoke:runner` needs `~/dev/bugme-sandbox` trusted (`cd ~/dev/bugme-sandbox && claude`, accept, quit).

## Gates

```bash
npm run typecheck && npm test        # runner files included in typecheck
# commandArgs: shell rendering parses back to the same argv (zsh, bash), hostile values (done)
# guards: Host exact match (wrong port, hostile suffix), Origin missing/null/wrong port, spoofed
#   forwarding headers, unauthenticated GETs and POSTs, public model routes 404, the model callback
#   without and with its token
# launch: stored brief only; unticked items, an unknown or escaping repo, a disconnected needed tool → refused;
#   a second launch returns the first; a `launching` record is reconciled from `claude agents` output
# model adapter: argv has --safe-mode, --no-session-persistence and no prompt; stdin carries it;
#   no prompt or output in logs (sentinel); timeout kills the child; at most two at once
# walk steps: parse, limits, https-only, no URL credentials; the canonical input has no id or time
# recorded: every prerequisite of the three examples has recorded steps

npm run e2e
# NEW runner project (its own spec files and temp state, HOME and ~/dev fixtures), with FAKE_MODEL and
# BUGME_CLAUDE_BIN = a stub that records argv and answers mcp list, agents --json and --bg.
# Launch is off until the boxes are ticked; an untrusted repo shows the fix; Launch passes the expected argv;
# a double tap launches once; each session state shows; an ask that arrives shows without a reload,
# keeping text typed into the answer box; How? shows steps; no horizontal scroll at 320px.

npm run e2e -- --project=recorded-desktop --project=recorded-phone
# How? steps on the three examples, from recordings

npm run smoke:runner
# NEW, real CLI (cents). Needs ~/dev/bugme-sandbox, which David trusts once (see Setup).
# Starts the runner on a temporary state directory; drafts a brief through the Claude login (Haiku);
# launches it through /runner/launch exactly as the page does; the session asks; the smoke answers
# as the owner; the session continues and reports. Asserts the ask and report landed on the runner,
# not on the user-scope bugme server. Then `claude rm` for that session only.

npm run smoke:live && npm run smoke:dispatch   # unchanged, still pass
python3 scripts/scan.py
```

**Setup, once, by David:** `mkdir -p ~/dev/bugme-sandbox && cd ~/dev/bugme-sandbox && git init && claude`, then accept the trust prompt and quit.

**Manual, by David:**
- open the runner on his phone over `tailscale serve`, and launch one real task;
- run "Do it with me" for one step.

**Spend:** walk-step recordings for the examples (Opus, about $0.15); smoke runs (cents each, on the Claude login).

## Out of scope (ROADMAP)

- A fully local model.
- Local-only tool access.
- Hard spending caps, and estimates calibrated from past runs.
- Push notifications.
- Answering Claude's own permission prompts from Bug Me.
- Session and worktree lifecycle: cancel, archive, retention, merging finished work.
- Narrower per-session credentials, device revocation, and Keychain storage.
- Other machines.
- Starting at login (launchd), and recovery across sleep and reboot.
- Watching tool connections continuously.
- The hosted page handing work to the runner.
- Pointing David's user-scope `bugme` server at the runner. That's one command, and it's David's call; README documents it.
- Changing Claude Code's settings or trust on the person's behalf.

## PRs

Each PR stays under the 2,000-line review cap.

- **9a, the runner:**
  - the front server, its guards and the Worker under it;
  - `LOCAL_MODEL_URL` and the model adapter;
  - launch, with its record and recovery;
  - saved ticks, and the session-state endpoint;
  - the stub `claude`, unit tests, `smoke:runner`.
- **9b, the page and the walk:**
  - Launch, the repo picker, session state and the refresh;
  - the walk schema, prompt, route and storage (its Worker changes included), with recordings;
  - How? and Do it with me;
  - honest local labels;
  - e2e, README and docs.

## Codex plan review (gpt-6.1-sol, high, 2026-10-14)

**Folded in:**
- **Authentication:** owner only on every route; public model routes 404; exact Host and Origin checks; the model callback has its own token; everything binds to loopback.
- **Privacy of draft calls:** `--safe-mode`, `--no-session-persistence`, the prompt on stdin, no logging (all checked on the CLI).
- **What "local" means:** labels separate where the work runs from who sees the model input.
- **Launch from the stored brief only:** ticks saved, the repo from a server-side list, trust and tools checked at launch.
- **Idempotent launch:** a reservation on the brief, reconciled from `claude agents`; `launched_at` kept apart from `dispatched_at`.
- **Refresh:** of asks and reports, not only CLI state; states that tell "waiting on Bug Me" from "needs you in Claude".
- **MCP config:** only `bugme` injected, no strict mode, an explicit URL and token, tools checked in the chosen repo.
- **Chrome:** guide-only, stops before secrets, asks for readiness first, launched with no AppleScript and no text in any command line.
- **Walk recordings:** a canonical input with no ids or times, and every shown prerequisite covered.
- **Smoke:** a trusted sandbox David sets up, the real launch path, a full ask → answer → continue → report.
- **Deadlines** set together, with a concurrency bound.
- **Smaller:** model availability metadata, startup and shutdown, an isolated Playwright project, sign-in-link wording, an explicit PR split.

**Declined:** none.

## Questions for David

- **"Local" (stage 8's routing):** you said sensitive work could run locally "to avoid the sensitive aspects and data leaking". With the runner, Bug Me's data and the work stay off Cloudflare, but Claude still sees the model input. The labels now say exactly that, and a fully local model is a ROADMAP line. Is that the leak you meant, or did you mean the model provider too?
