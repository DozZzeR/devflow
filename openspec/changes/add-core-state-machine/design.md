# Design

## Context

Empty repo with `docs/SPEC.md`, OpenSpec 2.1.0 and a bare `package.json`. Node 25 on the author's machine; target Node 22+. Windows is the primary platform. See proposal.md for motivation and `docs/SPEC.md` §4, §9 for the overall model.

## Goals / Non-Goals

**Goals:**
- A pure, fully unit-tested transition function; everything else (files, CLI) is a thin shell around it.
- State that survives crashes and is never silently overwritten.

**Non-Goals:**
- Executing stages (runners), running gates, reading OpenSpec changes, automatic escalation triggers. The core only records outcomes and accepts escalation requests.

## Decisions

1. **Pure reducer + effects shell.** `transition(state, event, config) → { state } | { error }` is a pure function over plain data. Events: `complete(stage, outcome)`, `approve`, `resume`, `escalate(reason)`, `setTier(tier)`. The CLI loads state, applies one event, writes state. Alternative: class with methods and file I/O inside. Rejected: harder to test exhaustively, and runners/MCP will reuse the reducer.

2. **Next stage is derived, not stored.** `nextStage(state)` computes from tier, state and counters. Storing it would create a second source of truth that can drift from the state.

3. **States.** `NEW`, `EXPLORED`, `DESIGNED` (awaiting approval), `PLAN_APPROVED`, `IMPLEMENTED`, `GATES_PASSED`, `DONE`, `HUMAN`. `REWORK` from SPEC §4.3 is modelled as `PLAN_APPROVED` + a `lastVerdict` field instead of a separate state: the next stage is the same (`implement`), only the input differs.

4. **Attempt counting.** The implement counter increments when `implement` is completed (ok or fail). `gates fail` and `verify rework` route back to implement; if the counter already equals `limits.implement`, the task goes to `HUMAN` with `limit_reached`. Verify counts the same way with `limits.verify`.

5. **Escalation.** `escalate(reason)` raises tier by one. `small → medium` resets to `NEW` (re-plan from explore) and keeps counters in history only. `medium → complex` keeps the approved plan but returns to `EXPLORED` so design runs again with the stronger role. Automatic triggers (SPEC §4.4) arrive with the gates change; here escalation is a CLI/API call (`devflow escalate <id> --reason`), used by tests and later by gates.

6. **Persistence.** `state.json` with `schema: 1`, written via temp file + `rename` (atomic on NTFS within one volume). Unknown schema or parse error → `invalid_state`, never overwrite.

7. **Config validation with zod `strict()`.** Errors are flattened to JSON paths. No silent defaults for an existing invalid file; defaults exist only in `init`.

8. **Project root discovery.** Walk up from cwd to the first directory containing `.devflow/`; `init` uses cwd (or `--dir`).

9. **CLI without a framework.** Hand-written argv parsing (7 commands, few flags) instead of commander/yargs, keeping runtime deps to `zod` only. Exit codes: 0 ok, 1 domain error (with `reason` in JSON on stderr when `--json`), 2 usage error.

10. **Build.** `tsc` to `dist/`, ESM, `"bin": { "devflow": "dist/cli.js" }`. Tests run against compiled output with `node --test dist/test`; this avoids a TS loader dependency.

## Impact zone

- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `.gitattributes`
- `.gitignore`
- `src/**`
- `test/**`
- `openspec/changes/add-core-state-machine/tasks.md`

## Test plan

- `test/lifecycle.test.ts`: every scenario of `specs/task-lifecycle/spec.md` against the pure reducer: stage order per tier, out-of-order rejection, rework routing, limits → HUMAN, approve/resume/tier rules, escalation paths including `complex` refusal.
- `test/config.test.ts`: every scenario of `specs/project-config/spec.md`: valid load, unknown field, missing role, command runner without template, init fresh / idempotent (in a temp dir).
- `test/store.test.ts`: atomic write leaves no partial file; invalid JSON and unknown schema → `invalid_state` without overwrite; duplicate start refused.
- `test/cli.test.ts`: spawn `node dist/cli.js` in a temp project: `init → start → next → complete …` happy path for small and medium, exit codes, `--json` output shape.

## Risks / Trade-offs

- [Reducer grows into a second OpenSpec status model] → it tracks execution only (attempts, gates, verdicts); artifact completeness stays OpenSpec's (`openspec status`) once the adapter lands.
- [Hand-written argv parsing gets messy as commands grow] → revisit when the command count passes ~12; switching is local to `src/cli.ts`.
- [`rename` over an existing file can fail on Windows if another process holds it open] → retry a few times with short backoff; covered by a store test with an open handle where feasible.
