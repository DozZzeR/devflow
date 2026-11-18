## ADDED Requirements

### Requirement: Approval delegation

Plan approval SHALL be done by a human unless the human runs `devflow delegate-approval <id> --to model` (or the matching MCP tool) for that task. A delegated task, on reaching plan approval, SHALL run the `review` role on the plan; its first line `APPROVE` approves with the plan binding, `REJECT: <reasons>` rejects with those reasons. Delegation is recorded in history and can be revoked with `--to human`.

#### Scenario: Default stays human

- **WHEN** a task without delegation finishes design
- **THEN** `devflow run` stops with `awaiting_plan_approval`

#### Scenario: Delegated approval

- **WHEN** approval for `t1` is delegated to a model and the reviewer answers `APPROVE`
- **THEN** the task is approved with a plan digest and `devflow run` continues to implement

#### Scenario: Delegated rejection

- **WHEN** the reviewer answers `REJECT: missing error case`
- **THEN** the task returns to design with that reason as feedback
