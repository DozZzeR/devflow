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

### Requirement: Verification context

The verify prompt SHALL include a block "Threat model and verification context" from the first source with text: the top-level `context` value of `openspec/config.yaml`, then `.devflow/context.md`. A source path in the task's change set MUST be read from the task base, so a task cannot change the context its own verifier receives. With no text in any source the block SHALL be omitted. Other stages SHALL NOT receive it.

#### Scenario: Context from openspec config

- **WHEN** `openspec/config.yaml` committed at the base has `context: |` followed by indented text, and `.devflow/context.md` also exists
- **THEN** the verify prompt contains a "Threat model and verification context" block with the YAML text and without the `.devflow/context.md` text

#### Scenario: Folded context with a header comment

- **WHEN** `openspec/config.yaml` has `context: > # note` followed by two indented lines, a blank line and a third indented line
- **THEN** the block contains the first two lines joined by a space, a line break, and the third line, and does not contain `# note`

#### Scenario: Fallback to .devflow/context.md

- **WHEN** `openspec/config.yaml` has no `context` key, or only a commented-out one, and `.devflow/context.md` is committed at the base
- **THEN** the verify prompt contains the block with the text of `.devflow/context.md`

#### Scenario: No source

- **WHEN** neither source has text
- **THEN** the verify prompt has no "Threat model and verification context" block

#### Scenario: Task edits its own context

- **WHEN** the task's change set modifies `.devflow/context.md` that was committed at the base
- **THEN** the verify prompt contains the base text, not the modified text

#### Scenario: Only verify receives it

- **WHEN** a medium task with a committed `.devflow/context.md` runs explore, design and verify
- **THEN** only the verify prompt contains the context text

### Requirement: Severity rubric

The built-in verify prompt SHALL define finding severity: high — an acceptance criterion is not met, data loss, or a leak or escape within the stated threat model; medium — a likely defect with a workaround; low — style, tests or hardening outside the threat model. It SHALL instruct REWORK only when at least one high or medium finding exists, and PASS with low findings as notes otherwise. In later rounds the round rule further limits which findings may be raised.

#### Scenario: Rubric in first round

- **WHEN** the built-in verify prompt is composed for round 1
- **THEN** it contains the high, medium and low definitions and the rule that REWORK needs at least one high or medium finding

#### Scenario: Rubric with round narrowing

- **WHEN** the built-in verify prompt is composed for round 2
- **THEN** it contains the severity definitions and the instruction to report only high-severity findings and regressions, and the narrowing text appears once
