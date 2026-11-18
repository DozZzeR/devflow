## MODIFIED Requirements

### Requirement: Outcome recording is the only way to advance

The system SHALL advance a task only through recorded stage outcomes. The stage MUST equal the stage currently reported by `next`; otherwise the command fails and state is unchanged. `devflow complete <id> <stage> <outcome>` records `ok`/`fail` for `explore`, `design`, `implement` and `pass`/`rework`/`human` for `verify`. The `gates` stage SHALL be recorded by `devflow gate <id>`; `devflow complete <id> gates` MUST accept only `fail`, or `ok` together with `--override "<reason>"`, which is recorded in history as a human override.

#### Scenario: Out-of-order stage is rejected

- **WHEN** `next` reports `explore` and the user runs `devflow complete feat-x implement ok`
- **THEN** the command exits non-zero with reason `stage_not_next`
- **AND** state is unchanged

#### Scenario: Verify rework returns to implement

- **WHEN** a task's next stage is `verify` and the user records outcome `rework`
- **THEN** the next stage becomes `implement` and the implement attempt counter is unchanged until implement runs again

#### Scenario: Verify pass finishes the task

- **WHEN** verify records `pass`
- **THEN** the task state is `DONE` and `next` reports stage `null` with reason `done`

#### Scenario: Gates cannot be marked ok by hand silently

- **WHEN** the next stage is `gates` and the user runs `devflow complete t1 gates ok` without `--override`
- **THEN** the command exits non-zero with reason `gates_need_gate_run` and state is unchanged

## ADDED Requirements

### Requirement: Task base and zone

`devflow start` SHALL record the current `HEAD` commit as the task base when the project is inside a git repository, and accept repeatable `--zone <glob>` options as the impact zone. `devflow zone <id> --from-design <file>` SHALL replace the zone with the list items of the file's `## Impact zone` section, and `devflow base <id> <commit>` SHALL set the base explicitly. Zone globs MUST be project-relative and MUST NOT contain `..`.

#### Scenario: Base recorded

- **WHEN** the project is a git repository at commit `abc123` and the user runs `devflow start t1 "X"`
- **THEN** the task state records base `abc123`

#### Scenario: Zone from design

- **WHEN** a design file has `## Impact zone` with items `- src/**` and `- test/**`
- **THEN** after `devflow zone t1 --from-design design.md` the task zone is `src/**`, `test/**`

### Requirement: Gate results in the lifecycle

A gates `pass` SHALL advance like `ok` and reset the consecutive-failure counter. A gates `fail` SHALL count as a failed implement attempt and increment the consecutive-failure counter. A gates `blocked` result MUST NOT consume an attempt, increment counters or escalate; it moves the task to `HUMAN` with the blocking reason.

#### Scenario: Blocked environment

- **WHEN** the rollback gate is `blocked` with `baseline_failed`
- **THEN** the task goes to `HUMAN` with reason `baseline_failed` and no counter changes

### Requirement: Automatic escalation triggers

On a gates `fail` the system SHALL first evaluate escalation, then attempt limits: escalate by one tier when the consecutive-failure counter reaches `limits.escalate_after` (`gates_failed_repeatedly`) or the failing gate is `zone` (`zone_violation`); on a second `rework` of a `medium` task escalate with `rework_repeated`. Escalation resets attempt and failure counters. A `complex` task goes to `HUMAN` with the trigger as reason instead. Escalation leaves the working tree unchanged.

#### Scenario: Repeated gate failures

- **WHEN** `limits.escalate_after` is 2 and a `small` task's gates fail twice in a row
- **THEN** the task becomes `medium` with reason `gates_failed_repeatedly`, restarts at `explore`, and its file changes remain

#### Scenario: Zone violation on complex

- **WHEN** a `complex` task's zone gate fails
- **THEN** the task goes to `HUMAN` with reason `zone_violation`

### Requirement: State upgrade

The system SHALL load schema-1 task files by upgrading them in memory to schema 2 (no base, no zone, zero counters) and write schema 2 on the next save. Unknown versions MUST still fail with `invalid_state`. Gates on an upgraded task without a base are `blocked` with `no_base` until `devflow base` sets one.

#### Scenario: Old task file

- **WHEN** a schema-1 `state.json` is loaded
- **THEN** commands work and the next save writes schema 2
