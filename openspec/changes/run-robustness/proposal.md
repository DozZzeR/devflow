# Proposal: run-robustness

## Why

Unattended `devflow run` loops fail for reasons that have nothing to do with the task:

- A Claude or Codex subscription hits its usage or rate limit. Today the role run counts as a normal failed run. It uses up an attempt and can trigger escalation or `limit_reached` (`HUMAN`). The next `devflow run` then follows that recorded failure instead of retrying the same stage.
- A human edits files while a task is running. The zone gate cannot tell those edits from the implementer's edits. A human edit outside the zone fails the gate with `outside_zone`, and that causes `zone_violation` escalation.

Both cases waste attempts, escalate tiers for no reason, and stop runs that should just wait or carry on.

## What Changes

- Runners classify a finished Claude or Codex run that ended on a subscription usage limit or a rate limit (HTTP 429). The run result gets `usageLimit`, with the reset text the CLI reported if there was one. Embedded punctuation such as `5 p.m.` is kept. For Codex, the search starts at the first matching line of the error block, so a later `ERROR: HTTP 429` line does not hide a reset printed just before it. A limited run is never `ok`. A run with a null exit (timeout, signal or kill) is never classified, for Claude or Codex, so devflow only pauses when the process actually ended on the limit. A Codex run must also exit non-zero.
- When a role run in the run loop (explore, design, implement, verify or delegated review) is limited, devflow records a **pause**. The pause does not count an attempt, increment counters, escalate, or move the task to `HUMAN`. The run loop stops with outcome `paused`, and `devflow run` exits with code 75. The task's next stage does not change, so the next `devflow run` retries the same stage. During a delegated review pause, `next` reports `review`, and the retry runs the reviewer again while approval stays pending. The next recorded event clears the pause.
- If the verify copy cannot be removed during a verify pause, the pause and attempt counts are kept, and the report carries `cleanup_failed` with the path. The copy stays in the OS temp directory. devflow does not store the path or retry the removal later, so it never deletes a path read back from task state.
- `devflow next` and `devflow status` (text and `--json`) show an active pause: the stage, when it started, and the reset text if the CLI gave one.
- When implement first starts for a task, devflow records every path that already differs from the task base, with a content hash. This is the **dirty snapshot**. Retries, rework and escalation keep it.
- The zone gate does not fail on an outside-zone path from the dirty snapshot whose content has not changed since that snapshot. It reports `preexisting_change:<path>` as a warning instead. An outside-zone path from the snapshot that the role changed, deleted or reverted still fails the gate.
- Known limitation: an ignore-rule change that hides an unchanged dirty file still fails the gate on that file. This is out of scope.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `runners`: usage-limit detection and reset text in the run result.
- `stage-execution`:
  - pause on a usage limit, including the delegated review
  - a failed verify-copy cleanup during a pause is reported, not retried
  - the run loop stops with `paused`
  - dirty snapshot at implement start
- `task-lifecycle`: a persisted pause that keeps the stage and attempts, shown in `next` (including `review`) and in `status`, and new optional state fields.
- `gates`: the zone gate exempts unchanged pre-existing changes and reports them as warnings.

## Impact

- Code: `src/limits.ts` (new), `src/runners.ts`, `src/stages.ts`, `src/review.ts`, `src/lifecycle.ts`, `src/snapshot.ts`, `src/gates.ts`, `src/cli.ts`.
- Generated: `plugins/claude/devflow/bin/devflow.mjs` and `plugins/codex/devflow/bin/devflow.mjs`. They are rebuilt from `src` by `scripts/build-plugins.mjs` into a temporary folder, and only these two files are copied back. They are never edited by hand. `plugins/**` stays in the impact zone.
- State: two new optional fields in `state.json` (`pause`, `dirtyAtImplement`) and two new history kinds (`pause`, `dirty`). The schema version stays 2, and older state files still load unchanged.
- API: `NextInfo.stage` can now also be `review`, but only while a delegated review is paused.
- CLI: `devflow run` gets a new exit code, 75, when the run pauses. Scripts that treat any non-zero exit as failure will see a pause as non-zero. This is intended, because the run did not finish.
- The evidence snapshot digest, the rollback gate, the verify copy and the trusted-config checks still use the full change set, including pre-existing changes.
- Tests: `test/limits.test.ts` (new), `test/run.test.ts`, `test/gates.test.ts`, `test/cli-gates.test.ts`, `test/lifecycle.test.ts`, `test/cli.test.ts`, `test/runners.test.ts`, `test/review.test.ts`, `test/fixtures/fake-agent.cjs`, `test/fixtures/fake-cli.cjs`.
