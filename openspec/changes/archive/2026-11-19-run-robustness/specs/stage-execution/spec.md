## ADDED Requirements

### Requirement: Pause on a usage limit

When a role run of explore, design, implement, verify or a delegated review returns `usageLimit`, the stage SHALL record a pause for that stage, with the runner and any reset text, and report outcome `paused` with reason `usage_limit`. It MUST NOT record a stage outcome, run generate, parse blocked or plan-conflict answers, or read a verdict. A verify pause still removes its copy.

#### Scenario: Implement hits the limit

- **WHEN** the implement role's run returns `usageLimit` with reset `5pm` on attempt 1 of 2
- **THEN** the stage report has outcome `paused` and reason `usage_limit`, the implement attempt count is 0, the task is not `HUMAN`, and `next` still reports `implement`

#### Scenario: Limited verify

- **WHEN** the verifier's run returns `usageLimit`
- **THEN** no `verify` outcome is recorded, the verify copy is removed, and the next run starts the same verify round

#### Scenario: No generate after a limit

- **WHEN** `build.generate` is configured and the implement run returns `usageLimit`
- **THEN** the generate command does not run

#### Scenario: Delegated review hits the limit

- **WHEN** a delegated review's run returns `usageLimit`
- **THEN** the task still awaits approval with delegation active, the pause names stage `review`, and the report's `next` reports stage `review`

#### Scenario: Next run retries the review

- **WHEN** a task paused at `review` and the user runs `devflow run` with the limit gone
- **THEN** the delegated reviewer runs as the first stage, and approval stays pending until its verdict is recorded

### Requirement: Verify copy cleanup during a pause

When a verify pause cannot remove the verify copy, the system SHALL still record the pause without changing attempts and SHALL report `cleanup_failed` with the copy path in the pause report's details. The copy stays in the OS temp directory. The system MUST NOT store the path in task state or try to remove it in a later run.

#### Scenario: Copy cannot be removed

- **WHEN** the verifier's run returns `usageLimit` and the verify copy cannot be removed
- **THEN** the report has outcome `paused` and `cleanup_failed` with the copy path, the verify attempt count is unchanged, and `state.json` does not contain the path

#### Scenario: Next run does not retry the removal

- **WHEN** a verify pause left a copy it could not remove, and the next `devflow run` runs with the limit gone
- **THEN** devflow does not try to remove the old copy, and verify runs with a new copy

### Requirement: Dirty snapshot at implement start

Before the first implement (or small) role run of a task with a base, the system SHALL record a content hash for every change-set path outside the task's plan folder. A file gets the SHA-256 of its bytes, a symbolic link gets a hash of its target, and a deleted path gets `null`. Later implement attempts, rework and escalation MUST keep the existing snapshot.

#### Scenario: Human edit before implement

- **WHEN** `README.md` differs from the base and implement starts for the first time
- **THEN** `state.json` stores `README.md` with its SHA-256 under `dirtyAtImplement`

#### Scenario: Deleted file

- **WHEN** `docs/old.md` was deleted in the working tree before implement starts
- **THEN** the snapshot stores `docs/old.md` with `null`

#### Scenario: Retry keeps the first snapshot

- **WHEN** implement attempt 1 edits `README.md` and fails, and attempt 2 starts
- **THEN** the snapshot still holds the hash `README.md` had before attempt 1

#### Scenario: Pause keeps the snapshot

- **WHEN** implement pauses on a usage limit after the snapshot was recorded, and the next `devflow run` retries implement
- **THEN** the snapshot is not recaptured

## MODIFIED Requirements

### Requirement: Run loop

`devflow run <id>` SHALL execute the next stage and continue until the task waits for a human, a stage fails, a stage pauses on a usage limit, or the task is `DONE`. `--once` executes exactly one stage. The gates stage runs through the gates. The command SHALL print one JSON line per executed stage and a final summary. It exits 1 after `fail` or `blocked`, 75 after `paused`, and 0 otherwise.

#### Scenario: Stops for approval

- **WHEN** a medium task runs explore and design successfully
- **THEN** `devflow run` stops with reason `awaiting_plan_approval`

#### Scenario: One stage

- **WHEN** the user runs `devflow run t1 --once` on a new medium task
- **THEN** only explore runs

#### Scenario: Stops on a pause

- **WHEN** design returns `usageLimit` during `devflow run t1`
- **THEN** no further stage runs, the last stage line has outcome `paused`, the final summary's `next` reports `design` with the pause, and the command exits 75

#### Scenario: Next run retries the stage

- **WHEN** a task paused at `design` and the user runs `devflow run t1` again with the limit gone
- **THEN** design runs as the first stage, with the same attempt number it would have had before the pause
