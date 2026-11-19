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

The zone gate SHALL pass only when every change-set path matches the task's impact zone, a trusted `build.outputs` glob, or lies under the task's plan folder `openspec/changes/<task-id>/`, and SHALL list every path outside all of them. Leading `./` segments of a glob MUST be ignored. A `medium` or `complex` task without a zone is `blocked` with reason `no_zone`; a `small` task without a zone passes with warning `no_zone`.

#### Scenario: File outside the zone

- **WHEN** the zone is `src/**` and the change set contains `README.md`
- **THEN** the zone gate fails and lists `README.md`

#### Scenario: Small task without a zone

- **WHEN** a `small` task has no zone
- **THEN** the zone gate passes with warning `no_zone`

#### Scenario: Own plan folder

- **WHEN** the zone is `src/**` and the change set contains `openspec/changes/<task-id>/tasks.md`
- **THEN** the zone gate passes

#### Scenario: Generated outputs join the zone

- **WHEN** the zone is `src/**`, `build.outputs` is `plugins/**`, and the change set contains `src/a.ts` and `plugins/x/index.js`
- **THEN** the zone gate passes

#### Scenario: Repeated leading ./ in an output glob

- **WHEN** the zone is `src/**`, `build.outputs` is `././plugins/**`, and the change set contains `src/a.ts` and `plugins/x/index.js`
- **THEN** the zone gate passes and does not list `plugins/x/index.js`

#### Scenario: Outputs alone are no zone

- **WHEN** a `medium` task has no zone and `build.outputs` is `plugins/**`
- **THEN** the zone gate is `blocked` with `no_zone`

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

### Requirement: Rollback regeneration

When `build.generate` is configured, the rollback gate SHALL run it in the temporary worktree's project directory after applying the changed test files (before the step 2 test run), and again after applying the remaining changes and any setup re-run (before the step 3 test run). A non-zero exit, timeout or kill makes the gate `blocked` with `generate_failed`. Its log joins the gate logs, and the worktree is still removed.

#### Scenario: Rollback worktree regenerates

- **WHEN** the rollback gate runs with `build.generate` configured
- **THEN** the command runs in the worktree project directory after each path application, before the step 2 and step 3 test runs, and never in the user's project root

#### Scenario: Step 2 generates after the test files are applied

- **WHEN** the generate command fails unless a changed test file is present in the worktree
- **THEN** the step 2 generate run succeeds, because it runs after the changed test files are applied

#### Scenario: Stale bundle fixed in the worktree

- **WHEN** a generated file's freshness test compares outputs with the applied sources
- **THEN** step 3 sees outputs regenerated from the applied sources, and the gate passes

#### Scenario: Generate fails in the worktree

- **WHEN** the generate command exits non-zero in the rollback worktree
- **THEN** the gate is `blocked` with `generate_failed`, the worktree is removed, and the user's `git status --porcelain` is unchanged

### Requirement: Pre-existing changes in the zone gate

For each path the zone gate would list as outside the zone, if the task's dirty snapshot holds that path and its current hash equals the snapshot hash, the gate SHALL NOT count it and SHALL add the warning `preexisting_change:<path>`. An outside-zone snapshot path whose hash differs MUST be listed as outside the zone. So MUST one that has left the change set, for example by being reverted to the base.

#### Scenario: Unchanged human edit

- **WHEN** the zone is `src/**`, `README.md` was dirty at implement start, and the role changed only `src/a.ts`
- **THEN** the zone gate passes with warning `preexisting_change:README.md`

#### Scenario: Role edits a dirty path

- **WHEN** `README.md` was dirty at implement start and the role changed its content
- **THEN** the zone gate fails with `outside_zone` and lists `README.md`

#### Scenario: Role reverts a dirty path

- **WHEN** `README.md` was dirty at implement start and the role restored it to the base content
- **THEN** the zone gate fails with `outside_zone` and lists `README.md`

#### Scenario: Pre-existing deletion kept

- **WHEN** `docs/old.md` was deleted before implement started and is still deleted
- **THEN** the zone gate does not list it and warns `preexisting_change:docs/old.md`

#### Scenario: New path outside the zone

- **WHEN** a dirty snapshot exists and the role creates `notes.txt` outside the zone
- **THEN** the zone gate fails and lists `notes.txt`

#### Scenario: No snapshot

- **WHEN** the task has no dirty snapshot and `README.md` is changed outside the zone
- **THEN** the zone gate fails and lists `README.md`, as before

### Requirement: Full change set for evidence

Pre-existing changes exempted by the zone gate SHALL still belong to the change set used by the evidence snapshot digest, the rollback gate, the verify copy and the trusted-config checks.

#### Scenario: Snapshot covers exempted paths

- **WHEN** `README.md` is exempted as a pre-existing change and changes after gates passed
- **THEN** verify does not run and the task returns to gates with `snapshot_changed`
