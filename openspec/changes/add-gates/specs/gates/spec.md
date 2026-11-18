## Purpose

Defines the deterministic checks devflow applies to a task's changes, independent of any model or CLI setting: whether changed files stay inside the task's impact zone, whether new tests actually fail without the production change, and whether the test suite passes; plus how gate results are reported and fed into the task lifecycle.

## ADDED Requirements

### Requirement: Change set

The system SHALL compute a task's change set as every file added, modified, deleted or renamed between the task base commit and the working tree, plus untracked files not ignored by git, excluding `.devflow/` itself. Paths SHALL be project-relative with forward slashes.

#### Scenario: Untracked file counts

- **WHEN** a role creates `src/new.ts` without staging it
- **THEN** the change set contains `src/new.ts`

#### Scenario: Deleted file counts

- **WHEN** a role deletes `src/old.ts` that existed at the base
- **THEN** the change set contains `src/old.ts`

### Requirement: Zone gate

The zone gate SHALL pass only when every path in the change set matches the task's impact zone. A task without a zone MUST fail the zone gate with reason `no_zone`, except for `small` tasks, which pass with a warning. The result SHALL list every path outside the zone.

#### Scenario: File outside the zone

- **WHEN** the zone is `src/**` and the change set contains `README.md`
- **THEN** the zone gate fails and lists `README.md`

#### Scenario: Small task without a zone

- **WHEN** a `small` task has no zone
- **THEN** the zone gate passes with warning `no_zone`

### Requirement: Rollback gate

The rollback gate SHALL, in a temporary git worktree at the task base: (1) run the test command and require it to pass (baseline); (2) apply only the changed test files and require the test command to fail; (3) apply the remaining changes and require it to pass. Test files are change-set paths matching `test.paths`. The user's working tree MUST NOT be modified, and the temporary worktree MUST be removed afterwards.

#### Scenario: Test that checks nothing

- **WHEN** the changed tests pass at the base without the production change
- **THEN** the rollback gate fails with reason `tests_check_nothing`

#### Scenario: Real regression test

- **WHEN** the changed tests fail at the base and pass with the production change
- **THEN** the rollback gate passes

#### Scenario: Working tree untouched

- **WHEN** the rollback gate runs, passing or failing
- **THEN** `git status` of the user's working tree is identical before and after

### Requirement: Rollback gate preconditions

The rollback gate MUST fail with reason `no_tests` when the change set contains no test files, and with reason `baseline_failed` when the baseline run fails, so that environment problems are never reported as a meaningful red. If `test.setup` is configured, it SHALL run in the temporary worktree before the baseline.

#### Scenario: Broken environment

- **WHEN** the test command fails in the worktree before any change is applied
- **THEN** the gate fails with `baseline_failed`, not `tests_check_nothing` and not pass

#### Scenario: No tests changed

- **WHEN** the change set has production files only
- **THEN** the rollback gate fails with `no_tests`

### Requirement: Tests gate

The tests gate SHALL run the configured test command in the project working tree and pass only on exit code 0, with a timeout (default 30 minutes).

#### Scenario: Failing suite

- **WHEN** the test command exits 1
- **THEN** the tests gate fails

### Requirement: Gate results

`devflow gate <id> [zone|rollback|tests|all]` SHALL print a JSON result per gate (name, passed, reason, details, duration) and write output of test runs to the task's log directory. Running `all` SHALL run zone, then tests, then rollback, and stop at the first failure.

#### Scenario: Stop at first failure

- **WHEN** the zone gate fails during `devflow gate t1 all`
- **THEN** the tests and rollback gates are not run and the result says so

### Requirement: Gates feed the lifecycle

When the task's next stage is `gates` and `devflow gate <id>` runs all gates, the system SHALL record the gates stage outcome (`ok` if all pass, otherwise `fail` with the failing gate) through the normal lifecycle transition. Running a single gate, or running gates when `gates` is not the next stage, MUST NOT change task state.

#### Scenario: Gates recorded

- **WHEN** a task's next stage is `gates` and all gates pass
- **THEN** the task advances exactly as if `devflow complete <id> gates ok` had been run

#### Scenario: Informational run

- **WHEN** the next stage is `implement` and the user runs `devflow gate t1 zone`
- **THEN** the result is printed and the task state is unchanged
