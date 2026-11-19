## ADDED Requirements

### Requirement: Subscription pause

A pause event SHALL name the stage `next` reports, or `review` while a delegated review awaits, and is rejected otherwise. It sets the task's `pause` (stage, reason `usage_limit`, runner, time, optional reset) and adds a `pause` history entry. It MUST NOT change status, attempts, counters or tier. `next` SHALL report the paused stage, including `review`, with the pause attached. Any other recorded event clears the pause.

#### Scenario: Pause keeps attempts

- **WHEN** implement is next with 1 attempt used and a pause for `implement` is recorded
- **THEN** status and attempts are unchanged (implement stays at 1), history ends with a `pause` entry, and `next` reports stage `implement`, attempt 2, and the pause

#### Scenario: Pause for another stage

- **WHEN** `next` reports `explore` and a pause for `implement` is recorded
- **THEN** the event fails with `stage_not_next` and state is unchanged

#### Scenario: Pause cleared by the next outcome

- **WHEN** a task paused at `explore` records `explore ok`
- **THEN** the task has no `pause`

#### Scenario: No human for limits

- **WHEN** `limits.implement` is 1 and implement pauses three times
- **THEN** the task is not `HUMAN` and the implement attempt count is 0

#### Scenario: Review pause in next

- **WHEN** a `DESIGNED` task with model approval records a pause for `review`
- **THEN** `next` reports stage `review` with reason `awaiting_plan_approval` and the pause, and after `approve` the pause is gone and `next` reports `implement`

### Requirement: Optional state fields

The state schema SHALL accept the optional fields `pause` and `dirtyAtImplement` (time and a map from path to hash or `null`), and the history kinds `pause` and `dirty`, without changing the schema version. State files without these fields MUST load unchanged.

#### Scenario: Older state file

- **WHEN** a schema-2 `state.json` written before this change is loaded
- **THEN** commands work and the task has no `pause` and no `dirtyAtImplement`

## MODIFIED Requirements

### Requirement: Status overview

`devflow status [<id>]` SHALL list tasks (or one task) with id, tier, state, next stage, attempt counts, escalation history and any active pause, as human-readable text or as JSON with `--json`. The pause shows the stage, the time it began, and the reset text, or `reset unknown` when the CLI gave none.

#### Scenario: Status as JSON

- **WHEN** the user runs `devflow status --json` with two tasks
- **THEN** the output is a JSON array with two entries

#### Scenario: Paused task in text status

- **WHEN** task `t1` paused at `implement` with reset `5pm`
- **THEN** `devflow status` prints a line for `t1` containing `paused`, `implement` and `resets 5pm`

#### Scenario: Paused task in JSON status

- **WHEN** task `t1` paused at `design` without a reset
- **THEN** `devflow status t1 --json` has `pause` with `stage: "design"`, `reason: "usage_limit"` and no `reset`, and its text form says `reset unknown`
