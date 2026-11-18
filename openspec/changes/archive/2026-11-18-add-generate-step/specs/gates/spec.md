## MODIFIED Requirements

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

## ADDED Requirements

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
