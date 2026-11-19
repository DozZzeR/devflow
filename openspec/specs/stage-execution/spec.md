# stage-execution Specification

## Purpose
Defines how devflow turns a task's next stage into one role run: which prompt, inputs, write scope and expected outputs each stage gets, how the run's result becomes a lifecycle outcome, how evidence (approved plan, gate results, verdict) is bound to the exact code it judged, and how stages run in the foreground or as a watchable background run.

## Requirements

### Requirement: Stage contracts

Each model stage SHALL run with a fixed contract. explore: read-only except `.devflow/runs/<id>/facts.md`, which it must produce. design: writes only `openspec/changes/<id>/**` and must produce fresh `proposal.md`, `design.md`, `tasks.md` and every spec delta present. implement (and small): writes only the task zone plus the change's `tasks.md`, may run the test command and the configured `build.generate` command. verify: see Verify isolation.

#### Scenario: Design cannot touch source

- **WHEN** the design stage runs with a `claude` runner and tries to edit `src/a.ts`
- **THEN** the edit is refused by the write scope

#### Scenario: Missing facts

- **WHEN** explore exits 0 without writing `facts.md`
- **THEN** the stage is recorded as `explore fail`

#### Scenario: Stale spec delta

- **WHEN** a redesign rewrites the three Markdown files but leaves an old spec delta untouched
- **THEN** the design stage fails with reason `stale_delta`

#### Scenario: Implementer may regenerate

- **WHEN** `build.generate` is `npm run build:plugins` and the implement stage runs with a `claude` runner
- **THEN** the allowed shell commands are the test command and `npm run build:plugins`

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

`devflow run <id>` SHALL execute the next stage and continue until the task waits for a human, a stage fails, a stage pauses on a usage limit, or the task is `DONE`. `--once` executes exactly one stage. The gates stage runs through the gates. The command SHALL print one JSON line per executed stage and a final summary. It exits 1 after `fail` or `blocked`, 75 after `paused`, and 0 otherwise.

#### Scenario: Stops for approval

- **WHEN** a medium task runs explore and design successfully
- **THEN** `devflow run` stops with reason `awaiting_plan_approval`

#### Scenario: One stage

- **WHEN** the user runs `devflow run t1 --once` on a new medium task
- **THEN** only explore runs

#### Scenario: Stops on a pause

- **WHEN** design returns `usageLimit` during `devflow run t1`
- **THEN** no further stage runs, the last stage line has outcome `paused`, the final summary's `next` reports `design` with the pause, and the command exits 75

#### Scenario: Next run retries the stage

- **WHEN** a task paused at `design` and the user runs `devflow run t1` again with the limit gone
- **THEN** design runs as the first stage, with the same attempt number it would have had before the pause

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

### Requirement: Generate step after implement

When the trusted gate configuration defines `build.generate`, the implement (or small) stage SHALL run it in the project root after a successful model run that is neither blocked nor a plan conflict, and before recording the outcome. It MUST use the test command's shell runner: same environment, `test.timeout_seconds`, process-tree termination and task log. Only exit code 0 records `implement ok`.

#### Scenario: Generate runs after implement

- **WHEN** `build.generate` is configured and the implement model run succeeds
- **THEN** the command runs once in the project root after the model run, and `implement ok` is recorded only after it exits 0

#### Scenario: No generate after a failed run

- **WHEN** the implement model run fails, reports blocked, or reports a plan conflict
- **THEN** the generate command does not run

#### Scenario: Trusted command

- **WHEN** the working-tree config changes `build.generate` but the base commit's config has another value
- **THEN** the base commit's command runs

### Requirement: Generate failure feedback

A generate run that exits non-zero, times out or is killed SHALL record `implement fail` with reason `generate_failed` and write `.devflow/runs/<id>/generate-failure.md` with the command, the exit code or timeout, and the last 80 log lines. The next implement prompt SHALL include that file. The file MUST be removed once that prompt is composed, before the model starts, and when generate succeeds.

#### Scenario: Failure feeds back

- **WHEN** the generate command exits 1 after printing `bundle error`
- **THEN** the stage reports `fail` with `generate_failed`, the implement attempt count rises, and the next implement prompt contains `bundle error`

#### Scenario: Feedback consumed before the retry runs

- **WHEN** the implement attempt after a generate failure starts its model run
- **THEN** `generate-failure.md` no longer exists, and the saved prompt of that attempt contains `bundle error`

#### Scenario: Feedback is not repeated

- **WHEN** the attempt after a generate failure generates successfully
- **THEN** `generate-failure.md` does not exist and later prompts do not contain the old log tail

### Requirement: Generated outputs in the zone

The `build.outputs` globs of the trusted configuration SHALL count as part of a task's impact zone when the task has a zone, matched with every leading `./` segment ignored, as in the zone gate. The implement prompt SHALL list them as generated paths that the generate command rewrites. They MUST NOT give a zone to a task that has none.

#### Scenario: Prompt lists outputs

- **WHEN** the zone is `src/**` and `build.outputs` is `plugins/**`
- **THEN** the implement prompt's impact zone lists `src/**` and marks `plugins/**` as generated

### Requirement: Regeneration in the verify copy

When `build.generate` is configured, verify SHALL run it in the temporary worktree's project directory after the change set is applied and after `test.setup`, before the verifier starts. A failure SHALL record `verify human` with reason `verify_generate_failed`, without running the verifier. The worktree MUST still be removed.

#### Scenario: Verify copy is regenerated

- **WHEN** verify runs with `build.generate` configured
- **THEN** the command runs with the verify worktree's project directory as cwd before the verifier is launched

#### Scenario: Generate fails in the verify copy

- **WHEN** the generate command exits non-zero in the verify worktree
- **THEN** the task records `verify human` with `verify_generate_failed` and the worktree is removed

### Requirement: Findings referenced by plan decisions

The built-in verify prompt SHALL request a `## Findings` section containing one unindented numbered item per finding. When an OpenSpec plan records decisions for a review round, devflow SHALL resolve those IDs from that section. Previously saved verdicts with a numbered list before the first Markdown heading SHALL remain usable. Each finding SHALL have exactly one decision. An ambiguous finding ID in the verdict SHALL be diagnosed separately from a missing decision in the plan.

#### Scenario: Test execution has its own numbered list

- **WHEN** both the Findings section and a later test section contain an item numbered 1
- **THEN** F1 refers only to the item in Findings

#### Scenario: An approved fix preserves its evidence

- **WHEN** implement or a later verify round receives approved decisions
- **THEN** each fix includes the original finding and the approved instruction, and deferred or dismissed items carry only their approved decisions

### Requirement: Pause on a usage limit

When a role run of explore, design, implement, verify or a delegated review returns `usageLimit`, the stage SHALL record a pause for that stage, with the runner and any reset text, and report outcome `paused` with reason `usage_limit`. It MUST NOT record a stage outcome, run generate, parse blocked or plan-conflict answers, or read a verdict. A verify pause still removes its copy.

#### Scenario: Implement hits the limit

- **WHEN** the implement role's run returns `usageLimit` with reset `5pm` on attempt 1 of 2
- **THEN** the stage report has outcome `paused` and reason `usage_limit`, the implement attempt count is 0, the task is not `HUMAN`, and `next` still reports `implement`

#### Scenario: Limited verify

- **WHEN** the verifier's run returns `usageLimit`
- **THEN** no `verify` outcome is recorded, the verify copy is removed, and the next run starts the same verify round

#### Scenario: No generate after a limit

- **WHEN** `build.generate` is configured and the implement run returns `usageLimit`
- **THEN** the generate command does not run

#### Scenario: Delegated review hits the limit

- **WHEN** a delegated review's run returns `usageLimit`
- **THEN** the task still awaits approval with delegation active, the pause names stage `review`, and the report's `next` reports stage `review`

#### Scenario: Next run retries the review

- **WHEN** a task paused at `review` and the user runs `devflow run` with the limit gone
- **THEN** the delegated reviewer runs as the first stage, and approval stays pending until its verdict is recorded

### Requirement: Verify copy cleanup during a pause

When a verify pause cannot remove the verify copy, the system SHALL still record the pause without changing attempts and SHALL report `cleanup_failed` with the copy path in the pause report's details. The copy stays in the OS temp directory. The system MUST NOT store the path in task state or try to remove it in a later run.

#### Scenario: Copy cannot be removed

- **WHEN** the verifier's run returns `usageLimit` and the verify copy cannot be removed
- **THEN** the report has outcome `paused` and `cleanup_failed` with the copy path, the verify attempt count is unchanged, and `state.json` does not contain the path

#### Scenario: Next run does not retry the removal

- **WHEN** a verify pause left a copy it could not remove, and the next `devflow run` runs with the limit gone
- **THEN** devflow does not try to remove the old copy, and verify runs with a new copy

### Requirement: Dirty snapshot at implement start

Before the first implement (or small) role run of a task with a base, the system SHALL record a content hash for every change-set path outside the task's plan folder. A file gets the SHA-256 of its bytes, a symbolic link gets a hash of its target, and a deleted path gets `null`. Later implement attempts, rework and escalation MUST keep the existing snapshot.

#### Scenario: Human edit before implement

- **WHEN** `README.md` differs from the base and implement starts for the first time
- **THEN** `state.json` stores `README.md` with its SHA-256 under `dirtyAtImplement`

#### Scenario: Deleted file

- **WHEN** `docs/old.md` was deleted in the working tree before implement starts
- **THEN** the snapshot stores `docs/old.md` with `null`

#### Scenario: Retry keeps the first snapshot

- **WHEN** implement attempt 1 edits `README.md` and fails, and attempt 2 starts
- **THEN** the snapshot still holds the hash `README.md` had before attempt 1

#### Scenario: Pause keeps the snapshot

- **WHEN** implement pauses on a usage limit after the snapshot was recorded, and the next `devflow run` retries implement
- **THEN** the snapshot is not recaptured
