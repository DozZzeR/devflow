# Proposal

## Why

devflow can record stages, run one role by hand (`exec-role`) and check changes (`gate`), but a human still has to write every prompt, choose write scopes and expected outputs, and translate role output into lifecycle outcomes. Until `devflow run` exists, the role separation and context narrowing that motivated devflow (docs/SPEC.md §1) only happen when someone assembles them manually, as we did for every verify so far. This change makes devflow drive a task end to end, stopping only where a human must decide.

## What Changes

- Built-in stage prompts for `explore`, `design`, `implement`, `verify` (and `small`), each with a fixed input set, write scope and expected outputs; written in the configured artifact language; overridable per project in `.devflow/prompts/<stage>.md`.
- Change artifacts in OpenSpec format: the design stage writes `openspec/changes/<task-id>/` (proposal, design with `## Impact zone` and `## Test plan`, tasks, spec deltas), whether or not OpenSpec is installed; `openspec validate --strict` runs when the CLI is available; the task zone is read from the design after the stage.
- Verify reads a narrowed context: specs deltas, tasks, `## Test plan` only, change set and gate results, never the rest of the design or implementer logs; its verdict file is parsed into `pass | rework | human` and bound to a hash of the change set; a second verify round focuses on high-severity findings and on regressions of round-1 findings.
- `devflow run <id> [--once]`: runs the next stage (or stages until a human stop, a failure or `DONE`), records outcomes through the lifecycle, runs gates at the gates stage.
- Background runs: `devflow run <id> --detach` returns a run id immediately; `devflow log <id> [--follow]` shows the live run log; `devflow status` shows whether a run is active. At most one active run per task.

## Capabilities

### New Capabilities

- `stage-execution`: how devflow turns the next stage into a role run (prompt, inputs, write scope, outputs), interprets the result, records it, and runs stages in the foreground or background.
- `change-artifacts`: the on-disk format of a task's plan (OpenSpec change folder plus devflow sections), its validation, and what each stage may read from it.

### Modified Capabilities

None. (`task-lifecycle`, `runners`, `gates` are used as specified.)

## Impact

- New `src/prompts.ts`, `src/stages.ts`, `src/artifacts.ts`, `src/background.ts`; CLI commands `run`, `log`; `status` shows active runs.
- Real model calls happen only when the user runs `devflow run`; automated tests use fake CLIs.
- Adds an OpenSpec-format folder to projects that do not use OpenSpec (`openspec/changes/<task-id>/`); no OpenSpec config or schema is written.
