# task-lifecycle Specification

## Purpose
Defines how a devflow task moves through stages and tiers: which stage runs next, how outcomes are recorded, attempt limits, escalation, decisions reserved for humans, and how task state is persisted.

## Requirements

### Requirement: Task creation

The system SHALL create a task with a unique id, a description, a tier (`small`, `medium` or `complex`; default `medium` when not given) and an optional tracker reference, starting in state `NEW`. Creating a task with an id that already exists MUST fail without modifying the existing task.

#### Scenario: Start a medium task

- **WHEN** the user runs `devflow start feat-x "Add export" --tracker GF-12`
- **THEN** `.devflow/runs/feat-x/state.json` exists with state `NEW`, tier `medium`, tracker `GF-12`
- **AND** the command exits with code 0

#### Scenario: Duplicate id

- **WHEN** a task `feat-x` exists and the user runs `devflow start feat-x "Other"`
- **THEN** the command exits non-zero with an error naming the existing task
- **AND** the existing `state.json` is unchanged

### Requirement: Stage order by tier

The system SHALL define the stage sequence per tier: `medium` and `complex` run `explore → design → (plan approval) → implement → gates → verify → done`; `small` runs `implement → gates → done`. Gates are a stage the core records but does not execute in this change.

#### Scenario: Small task skips planning

- **WHEN** a `small` task is in state `NEW`
- **THEN** `devflow next` reports stage `implement`

#### Scenario: Medium task starts with explore

- **WHEN** a `medium` task is in state `NEW`
- **THEN** `devflow next` reports stage `explore`

### Requirement: Next-stage resolution

`devflow next <id>` SHALL print a single JSON object containing the task id, current state, tier, next stage (or `null` when the task waits for a human or is done), the configured role (runner and model) for that stage, and the attempt number the stage would use. It MUST NOT change state.

#### Scenario: Next is read-only

- **WHEN** the user runs `devflow next feat-x` twice
- **THEN** both outputs are identical and `state.json` is unchanged

#### Scenario: Waiting for plan approval

- **WHEN** a `medium` task has completed `design`
- **THEN** `devflow next` reports stage `null` and reason `awaiting_plan_approval`

### Requirement: Outcome recording is the only way to advance

The system SHALL advance a task only through recorded stage outcomes. The stage MUST equal the stage currently reported by `next`; otherwise the command fails and state is unchanged. `devflow complete <id> <stage> <outcome>` records `ok`/`fail` for `explore`, `design`, `implement` and `pass`/`rework`/`human` for `verify`.

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

### Requirement: Attempt limits

The system SHALL count attempts per stage and enforce `limits.implement` and `limits.verify` from the project configuration. When a stage would exceed its limit, the task MUST move to state `HUMAN` and `next` MUST report stage `null` with reason `limit_reached`.

#### Scenario: Implement limit reached

- **WHEN** `limits.implement` is 2 and implement has failed (via `implement fail` or `gates fail`) twice
- **THEN** the task state is `HUMAN` and `next` reports reason `limit_reached`

### Requirement: Human-only decisions

Plan approval and tier downgrade SHALL be possible only through explicit human commands: `devflow approve <id>` and `devflow tier <id> <tier>`. `approve` MUST fail unless the task is awaiting plan approval. A task in `HUMAN` state SHALL resume only via `devflow tier` or `devflow approve --resume`, which resets the exhausted counter.

#### Scenario: Approve unlocks implement

- **WHEN** a task awaits plan approval and the user runs `devflow approve feat-x`
- **THEN** `next` reports stage `implement`

#### Scenario: Approve at the wrong time

- **WHEN** a task is in state `NEW` and the user runs `devflow approve feat-x`
- **THEN** the command exits non-zero with reason `not_awaiting_approval`

### Requirement: Tier escalation

The system SHALL raise a task's tier by one level when escalation is requested with a reason, record each change (from, to, reason, timestamp) in the task history, and keep tier changes visible in `status`. Escalating `small` to `medium` MUST restart the task at `explore`. Escalating `complex` MUST fail. Lowering a tier MUST only happen via `devflow tier`.

#### Scenario: Small escalates to medium

- **WHEN** a `small` task records `gates fail` and escalation to `medium` is requested with reason `gates_failed_twice`
- **THEN** the tier is `medium`, `next` reports `explore`, and history contains the escalation with its reason

### Requirement: State persistence

The system SHALL persist each task as JSON in `.devflow/runs/<id>/state.json`, written atomically (temporary file then rename), and include a schema version. A state file with an unknown schema version or invalid content MUST cause commands for that task to fail with a clear error rather than being overwritten.

#### Scenario: Corrupted state

- **WHEN** `state.json` contains invalid JSON and the user runs `devflow next feat-x`
- **THEN** the command exits non-zero with reason `invalid_state` and the file is left untouched

### Requirement: Status overview

`devflow status [<id>]` SHALL list tasks (or one task) with id, tier, state, next stage, attempt counts and escalation history, in human-readable text, and as JSON with `--json`.

#### Scenario: Status as JSON

- **WHEN** the user runs `devflow status --json` with two tasks
- **THEN** the output is a JSON array with two entries

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

### Requirement: Recording the gates stage

The `gates` stage SHALL be recorded by `devflow gate <id>`. `devflow complete <id> gates` MUST accept only `fail`, or `ok` together with `--override "<reason>"`, which is recorded in history as a human override.

#### Scenario: Gates cannot be marked ok by hand silently

- **WHEN** the next stage is `gates` and the user runs `devflow complete t1 gates ok` without `--override`
- **THEN** the command exits non-zero with reason `gates_need_gate_run` and state is unchanged
