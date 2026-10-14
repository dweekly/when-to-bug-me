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
- **Walk me through it:** short numbered steps for every "You first" item, on both the hosted and the runner page. On the runner, "Do it with me" also starts a Claude in Chrome session on the Mac that points the way and never types a secret.
- **One machine.** The Mac the runner is on. Other machines go on the ROADMAP.

The intent: from a phone or the laptop, a ticked brief becomes a running session in one tap, sized as briefed, asking and reporting back to the same Bug Me. Another design that does that with fewer moving parts would also serve.

## What changes

### The runner (`npm run runner`)

A Node process on the Mac, bound to `127.0.0.1` only. It runs two things.

**The Worker, unchanged, on the same machine.**
- Started with `wrangler dev`, as `smoke:live` and `smoke:dispatch` already do.
- Persists to `~/.bugme/state`, outside the repo.
- Its secrets (the seal key and the owner token) are generated on first run into `~/.bugme/runner.env` (mode 0600) and passed with `--env-file`, never on a command line.

**A front server** on one port. It passes everything to the Worker except `/runner/*`, which it handles itself.

Drafting uses the person's Claude Code login, not an API key:
- `ask()` in `src/worker/model.ts` is the one place the Worker calls the model.
- When `LOCAL_MODEL_URL` is set, `ask()` posts `{model, effort, schema, prompt}` to the runner instead of calling the API. No other Worker code changes.
- The runner answers with `claude -p --model <model> --effort <effort> --json-schema <schema> --output-format json --tools "" --strict-mcp-config`, run in an empty directory. It returns `structured_output`.
- That answer passes the same validation as an API answer.
- Owner calls are already `store: false`, so nothing is cached or recorded.
- Checked 2026-10-14 on Claude Code 2.1.299: `--json-schema` returns a `structured_output` object, $0.002 with Haiku.

**The tool catalog.** The runner reads the catalog itself, with the same parser as `sync-catalog` (`parseMcpList` in `mcp/bugme.mjs`):
- at start;
- when the person taps "Refresh tools".

### Launch

On the runner, the brief's primary action is **Launch**.
- **Gating:** it unlocks when every "You first" box is ticked, as Copy command does.
- **Repo:** a picker lists the git repos under `~/dev`. The last one chosen is remembered in the browser.
- **Record first:** launch calls the existing `/api/me/briefs/<id>/dispatched`, so the edits and copy time are recorded, then calls `POST /runner/launch {brief, repo}`.

The runner then starts the session with no shell in between (`execFile`). The command is:
`claude --bg --worktree bugme-<id> -n "<headline>" --mcp-config <file> <the brief's own arguments> -- <brief text>`

- **The brief's arguments:**
  - model, effort and permission mode;
  - `--disallowedTools` for the tools turned off.
- **Same as Copy command:** `buildCommand` is split into `commandArgs(brief, catalog)` and a shell renderer, so Launch and Copy command can't drift. A test checks that the zsh rendering parses back to the same argv.
- **The `--mcp-config` file** (0600, in `~/.bugme`) points Bug Me's server at the runner, so the session's asks and its report land in this Bug Me.
  - David already has a user-scope `bugme` server, so a gate checks which definition the session uses.
- **The page shows:**
  - the session's state (running, waiting for you, done) from `claude agents --json --all`;
  - its id, with `claude attach <id>` to copy.
  - Sessions also appear in the Claude app wherever Remote Control is on.

Checked 2026-10-14:
- `claude --bg --worktree <name> -n <name>` returns an id at once.
- `claude agents --json --all` reports `{id, cwd, name, status, state}`.
- `claude rm <id>` deletes the session and its worktree.
- `--bg` refuses a repo Claude Code doesn't trust yet ("Workspace not trusted. Run `claude` in <dir> once…"). The picker marks those repos and gives that fix instead of failing at launch.

### Walk me through it

Every "You first" item gets **How?**, which opens short numbered steps (at most five), each with an optional link.

**Where the steps come from:**
- a new model call, `walkFor(step, brief, catalog)`, with a schema and code checks;
- links must be `https`, and each is shown with its domain;
- the prompt says the person keeps every secret, so steps say where to paste it, never "paste it here".

**Where they're kept:**
- owner: stored on the brief (`store: false`);
- public demo: recorded steps for the three examples' prerequisites, labeled like every other card.

**On the runner, "Do it with me"** opens a Terminal window on the Mac (`osascript`), running an interactive `claude --chrome` session with a walk prompt. The session:
- opens the right page in Chrome and says what to click;
- stops where a secret goes and lets the person paste it;
- never reads a secret back.

The person ticks the box when it's done.

### Reaching it from a phone

`tailscale serve --bg <port>` serves the runner on the tailnet only, over HTTPS. David runs this himself, since it changes his tailnet's configuration.

Sign-in is the existing one-time link. The runner prints a fresh link with `npm run runner -- --link`.

Guards on the front server:
- `Host` must be localhost, 127.0.0.1 or the name set in `~/.bugme/runner.env`, so DNS rebinding can't reach it;
- every `/runner/*` POST checks `Origin` and the owner's session (the runner asks the Worker, forwarding the cookie);
- the brief's permission mode is one of the four allowed; bypass never is.

## Gates

```bash
npm run typecheck && npm test
# commandArgs: the shell rendering parses back to the same argv (zsh), hostile values included
# guards: the Host and Origin table; /runner/* refused without the owner's session
# walk steps: parse, limits, https-only links
# local model: LOCAL_MODEL_URL answers go through the same validation; nothing cached for the owner
# recorded: the recorded walk steps match the prompt

npm run e2e
# NEW runner project: the runner with FAKE_MODEL and BUGME_CLAUDE_BIN set to a stub that records
# its argv, prints an id and answers `agents --json`. Launch is off until the boxes are ticked;
# an untrusted repo shows the fix; Launch passes --bg --worktree bugme-<id>, the brief's arguments
# and the brief after --; the state shows; How? shows steps; no horizontal scroll at 320px.

npm run e2e -- --project=recorded-desktop --project=recorded-phone
# the three examples' How? steps render from recordings

npm run smoke:runner
# NEW, real CLI (cents): starts the runner on a temporary state directory; drafts a brief through
# the person's Claude login; launches it into a trusted scratch repo with Haiku; asserts the session's
# ask and report land on the runner (not the user-scope bugme server); then `claude rm`.

npm run smoke:live && npm run smoke:dispatch   # unchanged, still pass
python3 scripts/scan.py
```

**Manual, by David:**
- open the runner on his phone over `tailscale serve`, and launch one real task;
- run "Do it with me" for one step.

**Spend:** walk-step recordings for the three examples (Opus, about $0.10); smoke runs (cents each, on the Claude login).

## Out of scope

- Other machines, and choosing between them.
- The hosted page handing work to the runner.
- Starting the runner at login (launchd).
- Keychain storage for the runner's secrets.
- Pointing David's user-scope `bugme` server at the runner. That's one command, and it's David's call; README documents it.
- Claude in Chrome typing anything secret, or acting without the person watching.
- Changing Claude Code's settings or trust on the person's behalf.
- Imagine and Reflect.

## PRs

- **9a, the runner:**
  - the front server and the Worker under it;
  - `LOCAL_MODEL_URL`;
  - `commandArgs` and `/runner/launch`, plus sessions and the catalog;
  - guards, unit tests, `smoke:runner`.
- **9b, the page:**
  - Launch, the repo picker and session state;
  - How? and its recordings;
  - Do it with me;
  - e2e, README and docs.

Each PR stays under the review cap.
