## MODIFIED Requirements

### Requirement: Human-only decisions

Plan approval, plan rejection, approval delegation and tier downgrade SHALL be possible only through explicit human commands (`devflow approve`, `devflow approve --reject`, `devflow delegate-approval`, `devflow tier`) or the matching MCP tools invoked on the user's instruction. Approval and rejection through MCP MUST name the plan revision they judge (shown by `status`); the CLI accepts an optional `--revision`. A named revision that is not current fails with `plan_moved`. `approve` MUST fail unless the task is awaiting approval. A task in `HUMAN` resumes only via `devflow tier` or `devflow approve --resume`.

#### Scenario: Approve unlocks implement

- **WHEN** a task awaits plan approval and the user runs `devflow approve feat-x`
- **THEN** `next` reports stage `implement`

#### Scenario: Approve at the wrong time

- **WHEN** a task is in state `NEW` and the user runs `devflow approve feat-x`
- **THEN** the command exits non-zero with reason `not_awaiting_approval`

#### Scenario: Stale approval

- **WHEN** the user approves revision 1 but the plan was rejected and redesigned as revision 2
- **THEN** the command fails with `plan_moved`

## ADDED Requirements

### Requirement: Approval delegation

Without delegation a task SHALL stop for human approval after design. `devflow delegate-approval <id> --to model` SHALL make the run loop review the plan with the `review` role instead; `--to human` revokes it. Delegation and revocation are recorded in history; tasks created before this field existed default to human.

#### Scenario: Default stays human

- **WHEN** a task without delegation finishes design
- **THEN** `devflow run` stops with `awaiting_plan_approval`

#### Scenario: Revoked delegation

- **WHEN** delegation for `t1` was granted and then revoked with `--to human`
- **THEN** the next design result stops for human approval

### Requirement: Delegated review

A delegated review SHALL judge an immutable copy of the plan (taken with its digest before the review) in an isolated directory, on a `claude` or `codex` runner only. The last verdict line of its final answer decides: `APPROVE` approves that digest, `REJECT: <reasons>` rejects with those reasons; no verdict line stops for a human with `unreadable_review`.

#### Scenario: Delegated approval

- **WHEN** the reviewer answers `APPROVE` and nothing changed meanwhile
- **THEN** the task is approved with that plan digest and `devflow run` continues to implement

#### Scenario: Plan edited during review

- **WHEN** the plan changes while the reviewer runs
- **THEN** the verdict is discarded with `review_stale` and the task still awaits approval

### Requirement: Stale review

A delegated review verdict SHALL be applied only if, when it is recorded, the task is still awaiting approval, delegation is still active and the plan digest equals the reviewed copy's; otherwise it is discarded with `review_stale`.

#### Scenario: Delegation revoked during review

- **WHEN** the user revokes delegation while the reviewer runs
- **THEN** the verdict is discarded with `review_stale` and the task waits for the human
