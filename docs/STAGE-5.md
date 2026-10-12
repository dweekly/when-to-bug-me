# Stage 5: a morning that matches the proposal

## Why

The proposal's "compelling v1" says: overnight the agents raised 40 questions, Bug Me settled 31 itself (formatting, dependency bumps, a branch cleanup), and the rest reach the engineer in order, Launch first because one answer there unblocks six agents. The demo raised 28 and settled 4, so 24 reached Jordan. Reviewers will hold the demo to the proposal, and the product's promise (most of the night is handled, a few real decisions need you) is invisible when a quarter of the night is settled. David chose (2026-10-12) to rebuild the morning to 40 questions, 31 settled, 9 for Jordan, rather than change the proposal.

Another design that makes Home honestly read "31 handled, 9 need you" with the same tours would also do.

## What changes

**The nine that reach Jordan** (David, 2026-10-12): everything the proposal and the tours walk through, plus one quick check and the eval's control.

| Project | Decision | Why it stays |
| --- | --- | --- |
| Launch | `api-rename` | Launch first; unblocks six agents; the rule-quoted card |
| Launch | `webhook-rename` | re-framed by the API reason |
| Launch | `sdk-dependency` | pushback from last week's fact |
| Launch | `settings-redesign` | two clickable prototypes |
| Launch | `free-tier` | a cost decision with a bars picture; the eval's control |
| Billing | `reconciliation-path` | "Lost in translation" |
| Billing | `berlin-sync` | re-checked by the flight reason |
| Platform | `onsite-flight` | code overrules a settle; "say why" |
| Platform | `incident-action-items` | the one quick check |

**Removed** (15): `launch-slip`, `changelog-publish`, `deprecation-post`, `readiness-review`, `outage-chart`, `rate-limit-exception`, `provider-contract`, `duplicate-customers`, `sdk-comparison-budget`, `double-charge-reply`, `contractor-db-access`, `ci-runners`, `candidate-rejections`, `peer-review`, `test-runner-major`. None of them could honestly be settled under Bug Me's own rule (reversible, at most $50, cleared by a written rule), so they cannot become part of the 31; they leave the morning. The three with pictures (`outage-chart`, `ci-runners`, `provider-contract`) move into a test fixture so the chart and bars drawings stay tested.

**Added** (27 housekeeping decisions, settled with the existing 4 for 31): each squarely inside rule R2 (formatting, lint fixes, patch-level dependency bumps, deleting merged branches) or R7 (quarantine a flaky test with a ticket), in Jordan's own repos, internal only (nothing customers see, per R4), every option reversible at $0, the agent's pick "do it". Spread over the three projects. No meeting invites (the routing prompt treats accepting a meeting as hard to undo).

**Rules, facts and persona are unchanged**, so the nine kept decisions' recorded routes stay valid byte for byte. New recordings: the 27 routes, and the fact and re-route calls for the four examples (their prompts list the other waiting decisions, which changed). Entries for removed decisions are pruned from `recorded.json`.

**Copy**: README, the explainer and any count in the tours or tests say 40 / 31 / 9 where they said 28 / 4.

## Graduation gates

```bash
npm run record                      # 27 new routes + derived facts/re-routes (about $1.50)
npm run typecheck && npm test       # new: the recorded default morning routes exactly 31 of 40 to settled (after the code invariant), and the 9 named ones are not settled
npm run e2e                         # all projects; every tour on the keyless recorded server
npm run eval                        # 7 conditions x 3, all pass on the new morning
python3 scripts/scan.py
```

Plus: Home on the recorded run reads 40 questions, 31 settled, and recommends Launch first (unblocks six), checked by a screenshot at 1280 and 390.

If live routing does not settle a housekeeping decision, its wording is made plainer (not the rules, and not the code invariant) and it is re-recorded; a decision that still will not settle after two tries is replaced.

## Out of scope

- Changing the routing prompt, the settle invariant, or the rules.
- New tours, or new kinds of picture.
- The proposal text (David's).
