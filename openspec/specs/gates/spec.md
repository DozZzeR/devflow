# gates Specification

## Purpose
Defines the deterministic checks devflow applies to a task's changes, independent of any model or CLI setting: whether changed files stay inside the task's impact zone, whether new tests actually fail without the production change, and whether the test suite passes; plus how gate results are reported and fed into the task lifecycle.

## Requirements

### Requirement: Change set

The system SHALL compute a task's change set as every file added, modified, deleted or renamed (both paths) between the task base commit and the working tree, plus untracked files not ignored by git, limited to the project directory and excluding only `.devflow/runs/**` and `.devflow/logs/**`. Paths SHALL be project-relative with forward slashes, also when the project is a subdirectory of the git repository.

#### Scenario: Untracked file counts

- **WHEN** a role creates `src/new.ts` without staging it
- **THEN** the change set contains `src/new.ts`

#### Scenario: Deleted file counts

- **WHEN** a role deletes `src/old.ts` that existed at the base
- **THEN** the change set contains `src/old.ts`

#### Scenario: Devflow config edit counts

- **WHEN** a role edits `.devflow/config.json`
- **THEN** the change set contains `.devflow/config.json`

#### Scenario: Project in a subdirectory

- **WHEN** the project root is `app/` inside the git repository and `app/src/a.ts` changes
- **THEN** the change set contains `src/a.ts`

### Requirement: Gate outcomes

Every gate SHALL end as `pass`, `fail` (the change is wrong) or `blocked` (the check could not be performed: no git, no base, no zone on medium/complex, setup or baseline failure, test-run timeout, cleanup failure). A `blocked` result MUST never be reported as `pass` or `fail`.

#### Scenario: No git

- **WHEN** gates run in a project that is not a git repository
- **THEN** every gate is `blocked` with reason `no_git`

### Requirement: Zone gate

The zone gate SHALL pass only when every path in the change set matches the task's impact zone or lies under the task's own plan folder `openspec/changes/<task-id>/`, and SHALL list every path outside both. A `medium` or `complex` task without a zone is `blocked` with reason `no_zone`; a `small` task without a zone passes with warning `no_zone`.

#### Scenario: File outside the zone

- **WHEN** the zone is `src/**` and the change set contains `README.md`
- **THEN** the zone gate fails and lists `README.md`

#### Scenario: Small task without a zone

- **WHEN** a `small` task has no zone
- **THEN** the zone gate passes with warning `no_zone`

#### Scenario: Own plan folder

- **WHEN** the zone is `src/**` and the change set contains `openspec/changes/<task-id>/tasks.md`
- **THEN** the zone gate passes

### Requirement: Rollback gate

The rollback gate SHALL, in a temporary git worktree at the task base: (1) run the test command and require it to pass (baseline); (2) apply only the changed test files and require the test command to fail; (3) apply the remaining changes and require it to pass. Test files are change-set paths matching `test.paths`. The user's working tree, index and branches MUST NOT be modified.

#### Scenario: Test that checks nothing

- **WHEN** the changed tests pass at the base without the production change
- **THEN** the rollback gate fails with reason `tests_check_nothing`

#### Scenario: Real regression test

- **WHEN** the changed tests fail at the base and pass with the production change
- **THEN** the rollback gate passes

#### Scenario: Working tree untouched

- **WHEN** the rollback gate runs, with any outcome
- **THEN** `git status --porcelain` of the user's working tree is identical before and after

### Requirement: Rollback gate environment

If `test.setup` is configured it SHALL run in the temporary worktree before the baseline, and again before step 3 when any changed path matches `test.setup_inputs`. A failing setup or baseline makes the gate `blocked` (`setup_failed`, `baseline_failed`); no changed test files make it fail with `no_tests`. The worktree MUST be removed afterwards; if removal fails the gate is `blocked` with `cleanup_failed` and the path.

#### Scenario: Broken environment

- **WHEN** the test command fails in the worktree before any change is applied
- **THEN** the gate is `blocked` with `baseline_failed`

#### Scenario: Dependencies changed

- **WHEN** `package-lock.json` is in the change set and matches `test.setup_inputs`
- **THEN** `test.setup` runs again before step 3

#### Scenario: No tests changed

- **WHEN** the change set has production files only
- **THEN** the rollback gate fails with `no_tests`

### Requirement: What counts as red

In rollback step 2 the run SHALL count as red only when the test command exits with a code listed in `test.red_exit_codes` (default: any non-zero code); a timeout or a killed run makes the gate `blocked` (`test_run_error`). Red at suite level does not prove that every changed test fails; per-test evidence is out of scope of this gate.

#### Scenario: Timeout is not red

- **WHEN** the test command times out in step 2
- **THEN** the gate is `blocked` with `test_run_error`, not passed

### Requirement: Tests gate

The tests gate SHALL run the configured test command in the project working tree and pass only on exit code 0; a timeout makes it `blocked`.

#### Scenario: Failing suite

- **WHEN** the test command exits 1
- **THEN** the tests gate fails

### Requirement: Gate results

`devflow gate <id> [zone|rollback|tests|all]` SHALL print a JSON result per gate (name, outcome, reason, details, duration) and write test-run output to the task's log directory. `all` SHALL run zone, then tests, then rollback, and stop at the first non-pass result.

#### Scenario: Stop at first failure

- **WHEN** the zone gate fails during `devflow gate t1 all`
- **THEN** the tests and rollback gates are not run and the result says so

### Requirement: Gates feed the lifecycle

When the task's next stage is `gates` and `devflow gate <id>` runs all gates, the system SHALL record the result through the lifecycle (pass, fail with the failing gate, or blocked). Running a single gate, or running gates when `gates` is not next, MUST NOT change task state.

#### Scenario: Gates recorded

- **WHEN** a task's next stage is `gates` and all gates pass
- **THEN** the task advances to its next stage and history shows the gate results

#### Scenario: Informational run

- **WHEN** the next stage is `implement` and the user runs `devflow gate t1 zone`
- **THEN** the result is printed and the task state is unchanged

### Requirement: Gate snapshot

A passing set of gates SHALL record the evidence snapshot digest it checked, so that verify and task completion can confirm they judge the same code.

#### Scenario: Snapshot recorded

- **WHEN** `devflow gate t1` passes all gates at the gates stage
- **THEN** the task state stores the snapshot digest of that run
