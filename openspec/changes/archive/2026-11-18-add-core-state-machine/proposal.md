# Proposal

## Why

devflow (see `docs/SPEC.md`) needs a deterministic core before anything can run: something that owns task state, decides which stage comes next, and refuses stages that are out of order. Without it, runners and gates have nothing to plug into, and the "orchestrator is code, not a model" principle stays on paper.

## What Changes

- TypeScript project scaffold: `tsc` build, `node:test` tests, runtime deps limited to `zod` (MCP SDK arrives with the MCP change). `.gitattributes` to stop CRLF churn on Windows.
- Project configuration: `.devflow/config.json` with role/runner/model mapping, limits and test command, strictly validated; `devflow init` creates it plus `.devflow/.gitignore` (`runs/`).
- Task lifecycle state machine: tiers (small / medium / complex), states and allowed transitions, attempt counters and limits, upward tier escalation with recorded reason, human-only tier downgrade and plan approval.
- Run state persisted in `.devflow/runs/<id>/state.json`.
- CLI: `devflow init | start | next | complete | approve | tier | escalate | status`. `next` prints the next stage as JSON; `complete` records a stage outcome and is the only way state advances.
- Out of scope (later changes): runners (`claude` / `codex` / `command`), gates (zone, rollback, tests), OpenSpec change-store adapter, automatic escalation triggers, plugin, MCP server.

## Capabilities

### New Capabilities

- `task-lifecycle`: how a devflow task moves through stages and tiers: next-stage resolution, outcome recording, attempt limits, escalation, human-only decisions, persistence.
- `project-config`: the per-project devflow configuration file, its validation rules and its initialization.

### Modified Capabilities

None.

## Impact

- New code under `src/` (core, CLI) and `test/`; new `tsconfig.json`; `package.json` gains `bin`, scripts, `zod`, `typescript`, `@types/node`.
- Creates `.devflow/` in target projects only on `devflow init`; never touches the project's root `.gitignore`.
- No network calls, no model calls, no changes to OpenSpec files.
