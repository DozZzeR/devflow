## MODIFIED Requirements

### Requirement: Stage contracts

Each model stage SHALL run with a fixed contract. explore: read-only except `.devflow/runs/<id>/facts.md`, which it must produce. design: writes only `openspec/changes/<id>/**`. A first plan must produce fresh `proposal.md`, `design.md`, `tasks.md` and every spec delta present. A plan revision MAY keep current files. implement (and small): writes the task zone and `tasks.md`, and may run the test command and `build.generate`. verify: see Verify isolation.

#### Scenario: Design cannot touch source

- **WHEN** the design stage runs with a `claude` runner and tries to edit `src/a.ts`
- **THEN** the edit is refused by the write scope

#### Scenario: Missing facts

- **WHEN** explore exits 0 without writing `facts.md`
- **THEN** the stage is recorded as `explore fail`

#### Scenario: Stale spec delta

- **WHEN** a first-plan design rewrites the three Markdown files but leaves an existing spec delta untouched
- **THEN** the design stage fails with reason `stale_delta`

#### Scenario: Revision keeps a spec delta

- **WHEN** a plan revision leaves a valid current spec delta untouched
- **THEN** the design stage does not fail with `stale_delta`

#### Scenario: Implementer may regenerate

- **WHEN** `build.generate` is `npm run build:plugins` and the implement stage runs with a `claude` runner
- **THEN** the allowed shell commands are the test command and `npm run build:plugins`

## ADDED Requirements

### Requirement: Design revision after escalation

When the latest `reject`, `tier` or `escalate` entry records an escalation revision, design SHALL run as a revision. Its request MUST name the trigger and tier change and include all current plan files and the triggering evidence (verify verdict or gate result). Retained files MAY stay unchanged. The full design check MUST still pass.

#### Scenario: Escalation context reaches the designer

- **WHEN** a task escalated with `rework_repeated` at revision 5 runs design
- **THEN** the design prompt has a binding revision request naming `rework_repeated` and `medium → complex`, the current plan files, and the latest verify verdict

#### Scenario: A gate escalates before verify runs

- **WHEN** a medium task escalates after a gate failure and has no verify verdict
- **THEN** design receives the escalation trigger, the failed gate result and the current plan files

#### Scenario: Escalated redesign awaits approval

- **WHEN** the designer of the escalated task keeps the current spec delta and the plan passes the design check with human approval configured
- **THEN** design is recorded `ok` with details revision 5, and `devflow run` stops with `awaiting_plan_approval`

#### Scenario: Escalated redesign with delegated approval

- **WHEN** the escalated design passes the design check and plan approval is delegated
- **THEN** the task enters `DESIGNED` and the run loop invokes the delegated reviewer on the new revision before implementation

#### Scenario: Retry stays a revision

- **WHEN** the first design run after the escalation fails and design runs again
- **THEN** the retry gets the same escalation context, skips the freshness comparison, and reports revision 5

#### Scenario: Revision still needs a usable plan

- **WHEN** an escalation revision removes every spec delta
- **THEN** the design stage fails with reason `missing_spec_delta` and the task stays `EXPLORED` at revision 5
