## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Gate snapshot

A passing set of gates SHALL record the evidence snapshot digest it checked, so that verify and task completion can confirm they judge the same code.

#### Scenario: Snapshot recorded

- **WHEN** `devflow gate t1` passes all gates at the gates stage
- **THEN** the task state stores the snapshot digest of that run
