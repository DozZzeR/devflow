## ADDED Requirements

### Requirement: Task base and zone

`devflow start` SHALL record the current `HEAD` commit as the task base when the project is a git repository, and accept repeatable `--zone <glob>` options as the task's impact zone. `devflow zone <id> --from-design <file>` SHALL replace the zone with the list items of the file's `## Impact zone` section. Zone globs MUST be project-relative and MUST NOT contain `..`.

#### Scenario: Base recorded

- **WHEN** the project is a git repository at commit `abc123` and the user runs `devflow start t1 "X"`
- **THEN** the task state records base `abc123`

#### Scenario: Zone from design

- **WHEN** a design file has `## Impact zone` with items `- src/**` and `- test/**`
- **THEN** after `devflow zone t1 --from-design design.md` the task zone is `src/**`, `test/**`

### Requirement: Automatic escalation triggers

The system SHALL escalate a task by one tier, recording the trigger as the reason, when: the gates stage fails `limits.escalate_after` times in a row (`gates_failed_repeatedly`); the zone gate fails (`zone_violation`); or a `medium` task receives a second `rework` verdict (`rework_repeated`). A `complex` task MUST go to `HUMAN` instead of escalating. Counters of consecutive failures SHALL reset when the gates stage passes or the tier changes.

#### Scenario: Repeated gate failures

- **WHEN** `limits.escalate_after` is 2 and a `small` task's gates fail twice in a row
- **THEN** the task becomes `medium` with reason `gates_failed_repeatedly` and restarts at `explore`

#### Scenario: Zone violation on complex

- **WHEN** a `complex` task's zone gate fails
- **THEN** the task goes to `HUMAN` with reason `zone_violation`

### Requirement: State upgrade

The system SHALL load task state files with schema version 1 by upgrading them in memory to version 2 (no base, no zone, zero counters) and write version 2 on the next save. Unknown versions MUST still fail with `invalid_state`.

#### Scenario: Old task file

- **WHEN** a version-1 `state.json` is loaded
- **THEN** commands work and the next save writes version 2
