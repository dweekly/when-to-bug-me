# CLAUDE.md

Prototype for an Anthropic Labs take-home: Bug Me, a chief of staff that sits between a person and their fleet of agents, brings forward only the decisions that need them, and turns their reasons into standing guidance.

## Start here

Read `README.md`, then `docs/BUILD-PLAN.md` (the sequenced plan with pass/fail commands). If `private/HANDOFF.md` exists, read it too; it holds context that stays out of this public repo.

## Guardrails (non-negotiable)

- This repo is public. Never commit transcripts, extracted datasets, or anything derived from them. `private/`, `data/` and `*.jsonl` are gitignored; don't weaken that.
- Every person, company, project and question in `fixtures/` is synthetic and written by hand. Nothing comes from a real session.
- Treat `~/.claude/projects` as read-only source data. Never write there.
- Run `python3 scripts/scan.py` before every push (the pre-push hook does it). It fails closed if gitleaks cannot run.
- Label anything simulated as simulated, in the UI and the README. Every card says whether its content is live model output, a saved run, or code.
- The deployed Worker uses its own API key secret, never a key from a developer's keychain.

## How to work here

- Verify formats and APIs against real files and docs before writing parsers; prefer short exploratory tests to assumptions.
- Stay within the current stage in `docs/BUILD-PLAN.md`. Check in before changing scope or approach.
- No shortcuts: never skip, comment out or weaken failing tests.
- Test through the real entry point: Playwright against `wrangler dev` with the fake model, not just unit tests.
- Every tunable number lives in `src/shared/constants.ts` with a comment saying where it came from.
- Cite primary sources (docs, real files) for claims about tools and APIs; say when you're unsure.
