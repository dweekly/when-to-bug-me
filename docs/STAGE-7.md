# Stage 7: live fire

## Why

David (2026-10-12): "the more of an actual live fire exercise this is, the better. In a real fantasy world, maybe the hosted working prototype might be a simulation, but there is an actual chief of staff I am using to actually manage my work."

The prototype so far demonstrates the human side of Bug Me on a synthetic fleet. Every agent, question and send-down is fiction, and "Sent down to schema-migrator (simulated)" is where it ends. This stage closes the loop with real agents:

1. David's own Claude Code sessions ask Bug Me instead of stopping to ask him.
2. Bug Me routes each ask against David's written rules and settles what a rule clearly covers.
3. David answers the rest on a private page, with the same card and conversation as the simulation.
4. The answer, with his reason, goes back to the session that asked.

The public site stays the Jordan simulation; reviewers click that.

David's decisions (2026-10-12): build it in parallel with the thread UI; start from rules distilled from his CLAUDE.md; sign in with a secret link. If the loop isn't solid by Tuesday night, the recording uses the simulation and this goes into the proposal as v1.

The intent: one real question from one of David's real sessions travels the whole way, from ask to routing to his answer and back into the session, with nothing simulated on the path. Another design that does that with fewer moving parts would also do.

## What changes

### The ask: a local MCP server

`mcp/bugme.mjs` is a dependency-free stdio MCP server, plain Node ESM with no build step. It reads `BUGME_URL` from its environment, and the token from the macOS keychain (service `bugme-live`), so the token never sits in an MCP config file. An environment variable `BUGME_TOKEN` overrides the keychain, for tests. It has two tools:

**`ask_bug_me`**
- Inputs:
  - `question`;
  - `options`: 2–4 items, each `{key, label, pros?, cons?, reversible: yes|partly|no, cost_usd}`;
  - `recommended?`, `context`;
  - `project` (defaults to the basename of the session's working directory), `session` (a short label for the asking session);
  - `wait_minutes` (default 5, at most 10).
- Returns one of:
  - `{status: "settled", choice, label, rule, instruction}`: a written rule covered it;
  - `{status: "answered", outcome, choice?, label?, course?, reason, conditions, instruction, guidance?}`: David answered within the wait;
  - `{status: "pending", ticket, route, note}`.
- The description tells agents when to use it: instead of stopping to ask David, for business-intent calls, production deploys, spending real money, deleting data, and anything a rule says is his. It also says that `pending` means carry on with independent work and call `check_bug_me` later, and that settled answers quote the rule they rest on.

**`check_bug_me(ticket, wait_minutes?)`** returns the same shapes, plus:
- `{status: "reopened", note}` when David undoes an automatic answer;
- `{status: "set-aside", reason, instruction}` when he skips the decision with a reason.

The MCP server waits by polling the Worker every 3 seconds, so no Worker request is held open.

Registration is two commands, for David to run (not done by this stage): store the token in the keychain (it prompts for it), then add the server.

```bash
security add-generic-password -s bugme-live -a "$USER" -w
claude mcp add bugme --scope user -e BUGME_URL=https://bugme.weekly.org -- node ~/dev/when-to-bug-me/mcp/bugme.mjs
```

### The queue: a Durable Object per owner

`OwnerQueue`, one instance per owner (`idFromName("owner")`; there is one owner today), stores:
- **tickets**: the ask as a `Decision`, its routed `Card`, a status (`open`, `settled`, `answered`, `set-aside`, `reopened`), the answer, and timestamps;
- **the owner's rules and facts**, seeded on first use;
- **a short record** of resolutions.

The Decision is built from the ask:
- the id is `t-` plus 10 random characters;
- `project` comes from the ask, and `agent` is `[session]`;
- `waiting_minutes` is computed when the queue is read;
- `unblocks` is 1, because the asking session waits;
- each option's description is "For: …; Against: …";
- `bounds` come from the ask's `reversible` and `cost_usd`; a missing value counts as `no` and $9,999, so it can never settle.

Routing uses `routePrompt` and `enforceSettleInvariant` unchanged. One honest difference from the simulation: there, bounds are hand-authored; here, they are **the asking agent's own declaration**. The settle invariant still requires an exact clearing rule as well, and a wrong "reversible" from an agent is the agent's error, visible on the ticket.

### Sign-in

`LIVE_TOKEN` is a Worker secret, at least 32 random bytes, base64. There are two ways in:
- **MCP:** sends `Authorization: Bearer <token>`.
- **Browser:** David opens `https://bugme.weekly.org/me#k=<token>` once per device. The page reads the fragment, which never reaches the server or its logs, posts it to `/api/me/login`, and clears it from the address bar. The Worker answers with a cookie: `bugme_owner` = HMAC-SHA-256(LIVE_TOKEN, "owner-cookie"), `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=90 days`.

Every comparison is constant-time. Without `LIVE_TOKEN` set, every `/api/me/*` path returns 404. Owner endpoints accept only JSON bodies, which, with SameSite=Strict, covers CSRF.

### The private page: `/me`

The Worker serves `app.html` at `/me`, so the page is the same app. In live mode (`location.pathname === "/me"`):
- `api()` maps `/api/X` to `/api/me/X`;
- the saved state uses its own storage key;
- the header says "Live · your real queue";
- Tours are hidden, because they script Jordan's decisions.

`/api/me/queue` returns the same shape as `/api/queue`, with three differences:
- the persona is David's, and the projects are the ones his tickets name;
- `owner: true`;
- the cards are those of open and reopened tickets, plus the last 50 settled ones (for Decided for you).

Answered tickets leave the queue. Rules and facts come from the queue on every load, so desktop and phone agree. The page syncs them back after a save that changed them.

`/api/me/route`, `/api/me/answer`, `/api/me/fact` and `/api/me/converse` run the public handlers with the owner's world:
- decisions come from the Durable Object, and the persona is David's;
- live spending is allowed for the signed-in owner, without Turnstile, still under the daily cap;
- the response cache is never written or read, and recordings never match.

`/api/me/route` also saves the new card. If a re-route now settles an open ticket, the ticket is answered by the rule, and the asking session gets it on its next check.

### Delivery back

`src/page/live.ts` holds `deliver(id, payload)`, which posts to `/api/me/resolve`. A few one-line hooks in `src/page/actions.ts` call it:
- after `finalize`, with the choice, reason, conditions and send-down instruction;
- after `chooseOther`, and after the rejected path when stage 6c adds it, with the course;
- after `sendQuestionToAgent`, with the open questions;
- after `setAside`, with the reason and instruction;
- after a kept guidance or a reason given late, as an update;
- after `undo` of a settled ticket, which reopens it.

`resolve` merges updates, so a reason given after the answer still reaches the session on its next check.

### David's persona and starting rules

The persona is David with neutral pronouns. "How to work with me" holds four lines from his CLAUDE.md "How we work":
- ask every design question at once, each with a recommended default;
- plain English first, rigor underneath;
- push back on a bad plan;
- test a testable claim before asserting it.

The eleven starting rules are distilled from the "How we work" and "Always" sections:

| | Rule |
|---|---|
| L1 | Business intent and product decisions are mine; technical calls are yours. Make routine judgment calls yourself. |
| L2 | Production deploys need my explicit go. |
| L3 | Staging deploys from a commit on main need no permission: deploy, verify, report. |
| L4 | Spends of about a dollar need no permission; report the cost. Ask before real money. |
| L5 | Never delete, overwrite or prune data, `rm -rf`, or force-push without asking me. |
| L6 | Anything that goes out under my name (email, posts, board communication) comes to me. |
| L7 | Credentials and secrets never go in a repo. |
| L8 | MVP and product repos get a Codex review before merge; a new blocker on the second review pass comes to me. |
| L9 | Other people's networks: passive only, with no scans or probes unless the owner is present and has said yes. |
| L10 | Small, clear changes: just do them, with no plan or interview. |
| L11 | Merge with merge commits, never squash. |

They are editable on the private Rules page.

### Never in the repo, the logs, or a recording

Live data must stay in the owner's Durable Object:
- owner calls bypass the response cache and the recorded run;
- `scripts/record.ts` and the evals import only fixtures;
- no owner endpoint logs a body;
- the token never appears in a URL the server sees.

## Graduation gates

```bash
npm run typecheck && npm test   # auth (bearer, cookie, constant-time, 404 without LIVE_TOKEN), ask → Decision (bounds defaults), ticket lifecycle (open → settled | answered | set-aside | reopened, resolve merges), owner calls never touch the cache, record.ts imports no owner module
npm run e2e                     # the existing suite stays green; plus live.spec: /me with the cookie shows "Live · your real queue" and an asked ticket; answering it reaches /api/me/ticket
npm run smoke:live              # on a local stand-in Worker: the MCP server, driven over stdio, asks one question a rule covers (settled at once, rule quoted) and one it doesn't (pending); the second is answered through the page's API path; check_bug_me returns the answer with the reason
python3 scripts/scan.py
```

Then by hand, once David has set `LIVE_TOKEN` and registered the MCP server: one real ask from a real session, answered on his phone.

## Out of scope

- More than one owner; accounts.
- Push notifications. David checks `/me` or Bug Me's count. A notification channel is a roadmap line.
- Watching sessions for progress or stalls (the chief of staff "keeping tabs"), and harvesting questions from transcripts. Sessions ask explicitly.
- Injecting answers into a session that isn't waiting on `check_bug_me`.
- Production secrets and deploys: David's go.
