## ADDED Requirements

### Requirement: Escalation starts a plan revision

An automatic escalation from `medium` to `complex` SHALL start a new plan revision in the same transition. It increments `planRevision` by one, clears the plan digest and gates snapshot, and records `revision <N>` with the trigger in its `escalate` history entry. The task MUST need a new approval after design. A retried design MUST NOT increment the revision again. Manual escalation is unchanged.

#### Scenario: Second rework starts revision 5

- **WHEN** a `medium` task with an approved plan at revision 4 records its second verify `rework`
- **THEN** the task is `complex` in `EXPLORED` with `planRevision` 5 and no plan digest
- **AND** history has one new `escalate` entry with reason `rework_repeated`, from `medium`, to `complex` and results `revision 5`

#### Scenario: Gate triggers start a revision too

- **WHEN** a `medium` task with an approved plan at revision 2 fails the `zone` gate
- **THEN** the task is `complex` with `planRevision` 3 and its `escalate` entry has reason `zone_violation` and results `revision 3`

#### Scenario: Failed design retry keeps the revision

- **WHEN** the task escalated to revision 5 records `design fail` and later `design ok`
- **THEN** `planRevision` stays 5 and the task is `DESIGNED` awaiting plan approval

#### Scenario: Old revision cannot be approved

- **WHEN** the escalated task is `DESIGNED` at revision 5 and the user approves with `--revision 4`
- **THEN** the command fails with `plan_moved`

#### Scenario: Small escalation does not start a revision

- **WHEN** a `small` task escalates to `medium` with `gates_failed_repeatedly`
- **THEN** the task restarts at `explore`, its `planRevision` is unchanged and its `escalate` entry has no `results`
