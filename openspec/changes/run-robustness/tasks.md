# Tasks: run-robustness

## 1. Usage-limit detection

- [x] 1.1 Add `src/limits.ts` with `detectUsageLimit(runner, logText, exitCode)` and reset extraction (D1). Verify with `test/limits.test.ts`: Claude usage limit, Claude 429 without reset, Codex limit, echoed prompt, successful run mentioning 429, epoch reset, ordinary Claude error, command runner.
- [x] 1.2 In `runRole` (`src/runners.ts`), add `usageLimit?: { runner; reset? }` to `RunResult`, call the detector for `claude`/`codex` after the log is closed, and force `ok: false` on a limit. Verify with a `test/runners.test.ts` case where a fake `claude` prints the usage-limit JSON (check the result and the `exec-role` output).

## 2. Lifecycle pause and state fields

- [x] 2.1 In `src/lifecycle.ts`, add (D2, D4, D7):
  - the optional `pause` and `dirtyAtImplement` fields
  - the history kinds `pause` and `dirty`
  - the events `pause` and `dirty_snapshot`
  - pause clearing on every other event
  - `NextInfo.pause`

  Verify with `test/lifecycle.test.ts`:
  - pause keeps attempts
  - `stage_not_next`
  - cleared by `explore ok`
  - three pauses with `limits.implement: 1` never reach `HUMAN`
  - `review` pause only while awaiting delegated approval
  - `dirty_snapshot` not overwritten
  - an older schema-2 file loads

## 3. Stage handling and run loop

- [x] 3.1 Add `FAKE_LIMIT_ROLE`/`FAKE_LIMIT_OUTPUT` and `FAKE_IMPLEMENT_TOUCH` to `test/fixtures/fake-agent.cjs`. Verify with the tests that use them (groups 3 and 4).
- [x] 3.2 In `src/stages.ts`, record a pause and return `paused` for a limited stage (D3):
  - explore and design
  - implement, before blocked, conflict and generate handling
  - verify, with the copy still removed and no verdict read

  Verify with the `test/run.test.ts` cases "Implement hits the limit", "No generate after a limit" and "Limited verify".
- [x] 3.3 In `src/review.ts`, record a `review` pause for a limited delegated review. Verify with `test/review.test.ts` "Delegated review hits the limit" (stored pause).
- [x] 3.4 Stop `runLoop` on `paused`. In `devflow run` (`src/cli.ts`), exit 75 on a pause and add `outcome`/`pause` to the final summary. Verify with these `test/run.test.ts` CLI cases:
  - "Stops on a pause" (exit 75)
  - "Next run retries the stage" (same attempt)
  - `--once` exits 75

## 4. Dirty snapshot and zone gate

- [x] 4.1 Add `pathHashes` to `src/snapshot.ts`, and record the `dirty_snapshot` event at the first implement start in `src/stages.ts` (D4). Verify with these `test/run.test.ts` cases: "Human edit before implement", "Deleted file" (`null`), "Retry keeps the first snapshot" and "Pause keeps the snapshot".
- [x] 4.2 In `zoneGate` (`src/gates.ts`), exempt unchanged snapshot paths with `preexisting_change:<path>` warnings, and count changed, deleted or reverted snapshot paths (D5). Keep counting every snapshot path that left the change set, as D5 says: the ignore-rule case is a known limitation, so do not change it. Verify with these `test/gates.test.ts` cases: unchanged human edit, role edits, role reverts, deletion kept, new path, no snapshot.
- [x] 4.3 Verify the lifecycle wiring with `test/cli-gates.test.ts`: `devflow gate t1` with an unchanged dirty outside-zone path records gates pass without `zone_violation`, and its JSON carries the warning.
- [x] 4.4 Confirm that the evidence still covers exempted paths. Verify with the `test/run.test.ts` case "Snapshot covers exempted paths" (`snapshot_changed`).

## 5. Status

- [x] 5.1 In `src/cli.ts`, add `pause` to `summary()` and print the pause line in text status (D6). Verify with these `test/cli.test.ts` cases: text status with `resets 5pm`, JSON status without a reset, and text `reset unknown`.

## 6. First-round checkpoint

- [x] 6.1 First full-suite run, superseded by 7.6. The verify round found the issues fixed in group 7.

## 7. Rework from verify round 1

- [x] 7.1 Codex exit rule (D1). In `src/limits.ts`, classify Codex only when `typeof exitCode === "number" && exitCode !== 0`. Verify with the `test/limits.test.ts` case "Timed-out Codex run is not a limit": exit `null` plus an `ERROR: 429` line gives `undefined`.
- [x] 7.2 Reset text (D1). Implement the word-based `resetText`:
  - stop at the first word that ends with `.`
  - keep dotted abbreviations whole
  - strip the final period from other words
  - keep periods inside words

  Search the Codex error block (the matching line through the next blank line or the end, at most 10 lines). Verify with these `test/limits.test.ts` cases: "Punctuated reset" (`5 p.m.`), "Reset on a later line of the error" (`5:00 PM`), "Decimal in the reset" (`2.5 hours`), and the existing `5pm` and `5:00 PM` cases.
- [x] 7.3 Review pause as the next stage (D2):
  - Widen `NextInfo.stage` to `Stage | "review" | null`.
  - In `nextStage`, report `review` (with the review role, reason `awaiting_plan_approval` and no attempt) when the task is `DESIGNED`, approval is `model` and the pause stage is `review`.
  - In `runNextStage`, dispatch `review` to `runDelegatedReview`.
  - Check that `src/cli.ts` callers of `nextStage(...).stage` still compile and behave the same.

  Verify with these tests:
  - `test/lifecycle.test.ts` "Review pause in next"
  - `test/review.test.ts` "Delegated review hits the limit": the stage report has `next.stage === "review"`, and the CLI final summary has `next.stage === "review"` with exit 75
  - `test/review.test.ts` "Next run retries the review": the first stage line is `review`, the status stays `DESIGNED` until the verdict, and APPROVE gives `PLAN_APPROVED` with no pause
- [x] 7.4 Verify-copy cleanup during a pause (D3, D7):
  - Add `StageIo.removeCopy?: (root, path) => boolean`, defaulting to `removeDetached`. It is a test seam, used only at the existing removal point in `runVerify`'s `finally`.
  - In `runVerify`, when removal fails on the pause path, still record the pause (attempts unchanged) and add `details.cleanup_failed = <copy path>` to the `paused` report.
  - Do not add `pendingCleanup`, a `cleaned` event or history kind, a `cleanup` field on the pause event, or any removal retry in `runNextStage`. The copy stays in the OS temp directory.

  Verify with these `test/run.test.ts` cases:
  - "Verify copy cannot be removed during a pause": the report is `paused` with `details.cleanup_failed` equal to the copy path, `attempts.verify` is unchanged, and `state.json` does not contain the path.
  - "Next run does not retry the removal": a second `runNextStage` without the limit never calls `removeCopy` with the old path, and verify records round 1.
- [x] 7.5 Seeded attempts (verdict finding 6). Change the `test/lifecycle.test.ts` case "Pause keeps attempts" to seed one used implement attempt first: assert `attempts.implement === 1` after the pause and `next.attempt === 2`. In `test/run.test.ts` "Next run retries the stage", assert that the retry's `attempt` equals the pre-pause `next.attempt`. Verify that both tests pass.
- [x] 7.6 Regenerate the plugin bundles (D8) after all source changes, before the full suite:
  - Run `node scripts/build-plugins.mjs <temp dir outside the repo>`.
  - Copy only `<temp>/claude/devflow/bin/devflow.mjs` and `<temp>/codex/devflow/bin/devflow.mjs` over the repository files.
  - Delete the temp dir.

  Verify that `git status --porcelain plugins/` lists at most those two files. Repeat this step after any later source fix, before the next full-suite run.
- [x] 7.7 Run `npm test` (through `npm.cmd` if PowerShell blocks `npm.ps1`). Verify that every change-specific test passes and that no previously passing test fails. Report any failure that also fails on the base commit (such as the `test/proc.test.ts` grandchild timeout or the esbuild access-denied error in `test/plugins.test.ts`), with its output, as pre-existing rather than caused by this change.

## 8. Rework from verify round 2

- [x] 8.1 Null exit for every runner (D1). In `detectUsageLimit` (`src/limits.ts`), return `undefined` as the first statement when `exitCode === null`, before the Claude and Codex branches. Simplify the Codex condition to `exitCode !== 0`. Acceptance: runners scenario "Killed Claude run is not a limit". Verify with the new `test/limits.test.ts` case "Killed Claude run is not a limit": the `usage_limit_reached` JSON with `resets 5pm` and exit `null` gives `undefined`, while the same log with exit 0 and with exit 1 gives `{ runner: "claude", reset: "5pm" }`. The existing "Timed-out Codex run is not a limit" and "Claude usage limit" cases still pass.
- [x] 8.2 Reset search from the first matching line of the block (D1). In the Codex branch of `src/limits.ts`, after finding the last matching tail line `m`, walk back over non-blank lines to the first matching line `f` of the same block, and pass the lines from `f` through at most 10 lines after `m` (cut at the first blank line after `m`) to `resetText`. Acceptance: runners scenario "Several matching lines in one error block". Verify with the new `test/limits.test.ts` cases: `ERROR: You've hit your usage limit. Try again at 5:00 PM.` then `ERROR: HTTP 429` (exit 1) gives `reset: "5:00 PM"`; an older `ERROR: … try again at 3pm.` block, a blank line, then `ERROR: HTTP 429` gives no `reset`. The existing "Reset on a later line of the error", "Punctuated reset", "Decimal in the reset" and "Echoed prompt is not a limit" cases still pass.
- [x] 8.3 Regenerate the plugin bundles exactly as in 7.6 (D8), after 8.1 and 8.2. Depends on 8.1, 8.2. Verify that `git status --porcelain plugins/` lists at most the two `bin/devflow.mjs` files and that both contain the new null-exit check.
- [x] 8.4 Run `npm test` (through `npm.cmd` if PowerShell blocks `npm.ps1`). Depends on 8.3. Verify that every change-specific test passes and no previously passing test fails. Report the known base failures (the `test/proc.test.ts` grandchild timeout, the esbuild access-denied error in `test/plugins.test.ts`) with their output as pre-existing.

## Review decisions (round 2)

- F1 | fix | 8.1 | Reject a null exit before either vendor branch in `detectUsageLimit`, and add a Claude test with a matching final JSON object and a null exit.
- F2 | fix | 8.2 | Start the Codex reset search at the first matching line of the error block that holds the last matching line, and add a regression test with two matching lines in one block.

## Review decisions (round 1)

- F1 | fix | 7.3 | Expose review as the next stage during a delegated review pause and retry the reviewer.
- F2 | fix | 7.1 | A null Codex exit after a timeout or signal must not classify as a subscription limit.
- F3 | fix | 7.2 | Preserve punctuation in reset times and inspect the matching error block.
- F4 | defer | - | Changing ignore rules can hide an unchanged dirty file. Keep the conservative zone failure for this revision.
- F5 | fix | 7.4 | Report a failed verify-copy cleanup as `cleanup_failed` with the copy path in the pause details, and keep the pause and attempts. Do not store the path or retry the removal later; the copy stays in the OS temp directory.
- F6 | fix | 7.5 | Seed a used attempt before pausing and assert that the retry preserves its number.
