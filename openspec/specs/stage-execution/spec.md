# stage-execution Specification

## Purpose
Defines how devflow turns a task's next stage into one role run: which prompt, inputs, write scope and expected outputs each stage gets, how the run's result becomes a lifecycle outcome, how evidence (approved plan, gate results, verdict) is bound to the exact code it judged, and how stages run in the foreground or as a watchable background run.

## Requirements

### Requirement: Stage contracts

Each model stage SHALL run with a fixed contract. explore: read-only except `.devflow/runs/<id>/facts.md`, which it must produce. design: writes only `openspec/changes/<id>/**` and must produce fresh `proposal.md`, `design.md`, `tasks.md` and every spec delta present. implement (and small): writes only the task zone plus the change's `tasks.md`, may run the test command. verify: see Verify isolation.

#### Scenario: Design cannot touch source

- **WHEN** the design stage runs with a `claude` runner and tries to edit `src/a.ts`
- **THEN** the edit is refused by the write scope

#### Scenario: Missing facts

- **WHEN** explore exits 0 without writing `facts.md`
- **THEN** the stage is recorded as `explore fail`

#### Scenario: Stale spec delta

- **WHEN** a redesign rewrites the three Markdown files but leaves an old spec delta untouched
- **THEN** the design stage fails with reason `stale_delta`

### Requirement: Prompt composition

Each stage prompt SHALL be built from a built-in template for that stage, the task description and tracker reference, the artifact language, and only the inputs listed for that stage. A project file `.devflow/prompts/<stage>.md` SHALL replace the built-in template. The composed prompt SHALL be saved beside the run log.

#### Scenario: Project override

- **WHEN** `.devflow/prompts/verify.md` exists
- **THEN** the verify prompt uses it instead of the built-in template

#### Scenario: Prompt saved

- **WHEN** any stage runs
- **THEN** the exact prompt sent is stored beside that run's log

### Requirement: Plan approval binding

On `devflow approve` the system SHALL re-run the design checks, set the task zone from `## Impact zone`, and record a digest of the change folder excluding checkbox state in `tasks.md`. Before implement, gates and verify run, the digest SHALL be recomputed; on mismatch the task MUST return to plan approval with reason `plan_changed`.

#### Scenario: Plan edited after approval

- **WHEN** `design.md` changes after `devflow approve`
- **THEN** the next `devflow run` stops with `plan_changed` and waits for approval again

### Requirement: Evidence snapshot

Gate results and verdicts SHALL be bound to a snapshot digest computed over the task base, the effective gate configuration and, for every path in the change set, its path, file mode and content (or deletion). A pass verdict counts only if its snapshot equals the snapshot of the latest passing gates and of the working tree at recording time.

#### Scenario: Edit between gates and verify

- **WHEN** a file changes after gates passed and before verify runs
- **THEN** verify does not run and the task returns to the gates stage with reason `snapshot_changed`

### Requirement: Verify isolation

Verify SHALL run in a temporary worktree built from the task base plus the change set, without `design.md` beyond its `## Test plan` (provided in the prompt), without `facts.md` and without `.devflow/runs/`. It writes only `verdict.md` in that worktree, which devflow copies back to `.devflow/runs/<id>/`. The worktree is removed afterwards; edits it made are discarded.

#### Scenario: Verifier edits code

- **WHEN** the verifier modifies `src/a.ts` inside its worktree
- **THEN** the user's working tree is unchanged and the edit is discarded

### Requirement: Verify rounds

In a second verify round the prompt SHALL include the previous verdict and instruct the verifier to report only high-severity findings and regressions of earlier findings. The previous verdict is archived as `verdict-round<n>.md` before the next round.

#### Scenario: Second round is narrowed

- **WHEN** verify runs for the second time on a task
- **THEN** its prompt contains the first verdict and the high-severity-and-regressions instruction

### Requirement: Verdict interpretation

After verify the system SHALL read the first line of `verdict.md`: `VERDICT: PASS` → `pass`, `VERDICT: REWORK` → `rework`, `VERDICT: HUMAN` → `human`; anything else, a missing verdict or a failed run → `human` with a reason. `devflow complete <id> verify pass` MUST require `--override "<reason>"`, recorded in history.

#### Scenario: Rework verdict

- **WHEN** `verdict.md` starts with `VERDICT: REWORK`
- **THEN** the task records `verify rework` and returns to implement

#### Scenario: Manual pass needs override

- **WHEN** the user runs `devflow complete t1 verify pass` without `--override`
- **THEN** the command fails with `verify_needs_run`

### Requirement: Stale evidence limit

Returning to gates or approval because of `snapshot_changed` or `plan_changed` SHALL be counted per task; after 3 such returns the task MUST go to `HUMAN` with reason `evidence_unstable`.

#### Scenario: Endless edits

- **WHEN** the snapshot changes before verify for the third time
- **THEN** the task goes to `HUMAN` with `evidence_unstable`

### Requirement: Run loop

`devflow run <id>` SHALL execute the next stage and continue until the task waits for a human, a stage fails, or the task is `DONE`; `--once` executes exactly one stage. The gates stage runs through the gates. The command SHALL print one JSON line per executed stage and a final summary.

#### Scenario: Stops for approval

- **WHEN** a medium task runs explore and design successfully
- **THEN** `devflow run` stops with reason `awaiting_plan_approval`

#### Scenario: One stage

- **WHEN** the user runs `devflow run t1 --once` on a new medium task
- **THEN** only explore runs

### Requirement: Background runs

`devflow run <id> --detach` SHALL reserve the task's run lock before starting a separate process, print a run id and return. The lock is released when the run ends, and is cleaned if its process is dead; a failed start releases it. `devflow log <id> [--follow]` shows the run's live log and `devflow status` the active run. A second run on a locked task fails with `run_active`.

#### Scenario: Detached run

- **WHEN** the user runs `devflow run t1 --detach`
- **THEN** the command returns a run id within seconds and `devflow log t1` shows the run's output so far

#### Scenario: Simultaneous starts

- **WHEN** two `devflow run t1 --detach` commands start at the same moment
- **THEN** exactly one run starts and the other fails with `run_active`
