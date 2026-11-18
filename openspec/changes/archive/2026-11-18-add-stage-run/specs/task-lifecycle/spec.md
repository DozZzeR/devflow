## ADDED Requirements

### Requirement: Recording the verify stage

`devflow complete <id> verify` SHALL accept `rework` and `human`; `pass` MUST require `--override "<reason>"`, recorded in history as a human override. Without an override a pass is recorded only by `devflow run` with a verdict bound to the current snapshot.

#### Scenario: Manual pass needs override

- **WHEN** the user runs `devflow complete t1 verify pass` without `--override`
- **THEN** the command fails with `verify_needs_run` and state is unchanged

### Requirement: Evidence invalidation

The lifecycle SHALL support returning a task to plan approval (`plan_changed`) or to the gates stage (`snapshot_changed`) without consuming attempts or counting as a failure, and SHALL count such returns; the third return MUST move the task to `HUMAN` with reason `evidence_unstable`.

#### Scenario: Back to gates

- **WHEN** the snapshot changed before verify
- **THEN** the task's next stage is `gates`, attempts are unchanged and the return counter increments
