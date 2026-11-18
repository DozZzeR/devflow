# task-lifecycle Specification

## Purpose
TBD - created by archiving change add-core-state-machine. Update Purpose after archive.

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

The system SHALL advance a task only through `devflow complete <id> <stage> <outcome>`. The stage MUST equal the stage currently reported by `next`; otherwise the command fails and state is unchanged. Allowed outcomes: `ok` and `fail` for `explore`, `design`, `implement`, `gates`; `pass`, `rework` and `human` for `verify`.

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
