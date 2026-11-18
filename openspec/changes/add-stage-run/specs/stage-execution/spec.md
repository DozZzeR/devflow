## Purpose

Defines how devflow turns a task's next stage into one role run: which prompt, inputs, write scope and expected outputs each stage gets, how the run's result becomes a lifecycle outcome, and how stages run in the foreground or as a background run that can be watched.

## ADDED Requirements

### Requirement: Stage contracts

Each model stage SHALL run with a fixed contract. explore: read-only except `.devflow/runs/<id>/facts.md`, which it must produce. design: writes only `openspec/changes/<id>/**` and must produce `proposal.md`, `design.md` and `tasks.md` there. implement (and small): writes only the task zone plus the change's `tasks.md`, may run the test command. verify: writes only `.devflow/runs/<id>/verdict.md`, which it must produce.

#### Scenario: Design cannot touch source

- **WHEN** the design stage runs with a `claude` runner and tries to edit `src/a.ts`
- **THEN** the edit is refused by the write scope

#### Scenario: Missing facts

- **WHEN** explore exits 0 without writing `facts.md`
- **THEN** the stage is recorded as `explore fail`

### Requirement: Prompt composition

Each stage prompt SHALL be built from a built-in template for that stage, the task description and tracker reference, the artifact language from the configuration, and only the inputs listed for that stage. A project file `.devflow/prompts/<stage>.md` SHALL replace the built-in template for that stage. The composed prompt SHALL be saved next to the run log.

#### Scenario: Project override

- **WHEN** `.devflow/prompts/verify.md` exists
- **THEN** the verify prompt uses it instead of the built-in template

#### Scenario: Prompt saved

- **WHEN** any stage runs
- **THEN** the exact prompt sent is stored beside that run's log

### Requirement: Verify context

The verify prompt SHALL include the change's spec deltas, `tasks.md`, only the `## Test plan` section of `design.md`, the current change set and the latest gate results, and MUST NOT include the rest of `design.md`, `facts.md` or logs of other roles. In a second verify round it SHALL also include the previous verdict and instruct the verifier to report only high-severity findings and regressions of earlier findings.

#### Scenario: Design reasoning hidden

- **WHEN** `design.md` contains a `## Decisions` section
- **THEN** the verify prompt does not contain that section's text

#### Scenario: Second round is narrowed

- **WHEN** verify runs for the second time on a task
- **THEN** its prompt contains the first verdict and the high-severity-and-regressions instruction

### Requirement: Verdict interpretation

After verify, the system SHALL read the first line of `verdict.md`: `VERDICT: PASS` → `pass`, `VERDICT: REWORK` → `rework`, `VERDICT: HUMAN` → `human`; anything else → `human` with reason `unreadable_verdict`. The verdict SHALL record a hash of the change set's content at verify time; a `pass` whose hash no longer matches the working tree MUST NOT finish the task.

#### Scenario: Rework verdict

- **WHEN** `verdict.md` starts with `VERDICT: REWORK`
- **THEN** the task records `verify rework` and returns to implement

#### Scenario: Stale pass

- **WHEN** a pass verdict was recorded and files changed afterwards before the task was closed
- **THEN** `devflow run` reports `stale_verdict` and reruns gates and verify instead of finishing

### Requirement: Stage outcomes

The system SHALL record `ok` for a model stage whose run succeeded (exit 0, outputs fresh, stage checks passed) and `fail` otherwise. For design, stage checks are: required files present, `## Impact zone` parsable, and `openspec validate <id> --strict` passing when the OpenSpec CLI is available. After a successful design the task zone SHALL be set from `## Impact zone`.

#### Scenario: Invalid change

- **WHEN** design writes files but `openspec validate --strict` fails
- **THEN** the stage is recorded as `design fail` and the validation output is in the log

### Requirement: Run loop

`devflow run <id>` SHALL execute the next stage and continue with following stages until the task waits for a human (plan approval, `HUMAN`), a stage fails, or the task is `DONE`; `--once` SHALL execute exactly one stage. The gates stage SHALL run through the gates. The command SHALL print one JSON line per executed stage and a final summary.

#### Scenario: Stops for approval

- **WHEN** a medium task runs explore and design successfully
- **THEN** `devflow run` stops with reason `awaiting_plan_approval`

#### Scenario: One stage

- **WHEN** the user runs `devflow run t1 --once` on a new medium task
- **THEN** only explore runs

### Requirement: Background runs

`devflow run <id> --detach` SHALL start the run loop in a separate process, print a run id and return immediately. The run's progress SHALL be written to a log that `devflow log <id> [--follow]` shows while it runs, and `devflow status` SHALL show the active run. A task MUST NOT have two active runs; starting a second one fails with `run_active`.

#### Scenario: Detached run

- **WHEN** the user runs `devflow run t1 --detach`
- **THEN** the command returns a run id within seconds and `devflow log t1` shows the run's output so far

#### Scenario: Second run refused

- **WHEN** a run for `t1` is active and the user starts another
- **THEN** the second command fails with `run_active`
