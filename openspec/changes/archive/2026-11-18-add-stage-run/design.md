# Design

## Context

Lifecycle, runners (`runRole`), gates (with temporary worktrees) and OpenSpec 2.1.0 in the repo exist (`openspec/specs/*`). Until now every role run was assembled by hand. The verify rule accepted on 2026-11-18 (two rounds; round 2 only high findings and regressions) is in `docs/TODO.md`. A Codex plan review (`.devflow/runs/add-stage-run/plan-review.md`, REWORK, 8 findings) shaped decisions 5–10.

## Goals / Non-Goals

**Goals:**
- One command that drives a task through its stages with the contracts in the specs.
- Evidence (approved plan, gate results, verdict) bound to the exact content it judged.
- A verifier that cannot read the author's reasoning or change the user's files.
- Watchable long runs without MCP.

**Non-Goals:**
- MCP server and plugins (next changes); they will call the same run loop.
- Read isolation for explore/design/implement: they work in the real repository and can open any file; "visibility" for them is what the prompt hands over.
- Automatic tier triage (SPEC §4.4).

## Decisions

1. **Prompts as TypeScript string templates** (`src/prompts.ts`) with `{{placeholders}}`; override in `.devflow/prompts/<stage>.md`. Each template states the job, exact outputs and format, the write scope in words (the runner enforces it), and "write in {{language}}". The design template tells the model to rewrite every spec delta it keeps and delete obsolete ones.

2. **Inputs are inlined** (task, spec deltas, test plan, change-set list, gate summary) plus file paths to read on demand for explore, design and implement.

3. **Stage → runRole mapping** (`src/stages.ts`): role, write globs, allowed shell commands (`[test.command]` for implement/small), expected outputs, timeout.

4. **Design post-checks** (`src/artifacts.ts`): `proposal.md`, `design.md`, `tasks.md` and every file under `specs/` must be fresh (the existing snapshot-before-run check; unchanged delta → `stale_delta`); `## Impact zone` parses; validation per `openspec.cli` (`auto` resolves `openspec` on PATH or `node_modules/.bin`; `on` requires it; `off` skips).

5. **Plan digest at approval.** `devflow approve` re-runs the design checks, stores the zone and `planDigest` = SHA-256 over sorted `path\0content` of the change folder, with `tasks.md` normalised (checkbox marks `[x]`/`[ ]` erased). `run` recomputes before implement, gates and verify; mismatch → event `invalidate { to: "approval", reason: "plan_changed" }`.

6. **Evidence snapshot.** `snapshotDigest` = SHA-256 over: base commit, SHA-256 of the effective gate config, and for each change-set path sorted: path, file mode (`stat.mode & 0o777`, `0` on Windows where modes are meaningless), content hash or `<deleted>`. Passing gates store `gatesSnapshot`. Before verify and before recording `pass`, the current digest must equal `gatesSnapshot`; otherwise `invalidate { to: "gates", reason: "snapshot_changed" }`. The verdict stores the snapshot it judged.

7. **Verify isolation.** Reuse the rollback worktree machinery: worktree at base, apply the full change set, delete `openspec/changes/<id>/design.md` and any `.devflow/` folder from the worktree, run `test.setup` if configured (so the verifier can run tests), then run the verify role with cwd = worktree project dir and write scope `.devflow-verdict.md` inside it. devflow copies that file to `.devflow/runs/<id>/verdict.md`, removes the worktree, and discards any other edits. The design's `## Test plan` and the gate summary are in the prompt.

8. **Lifecycle additions.** Event `invalidate { to, reason }` (no attempt consumed; `counters.staleEvidence++`; ≥ 3 → `HUMAN: evidence_unstable`). `complete verify pass` needs `override`. A verify run that fails or produces no readable verdict is recorded as `human` with the reason. State fields: `planDigest`, `gatesSnapshot`, `lastVerdict.snapshot`, `counters.staleEvidence`.

9. **Zone gate allowance.** Paths under `openspec/changes/<task-id>/` are always in zone for that task (plan integrity is the plan digest's job).

10. **Background runs with lock-first.** `run --detach`: create `.devflow/runs/<id>/run.json` with flag `wx` and `{ runId, status: "starting", startedAt }` **before** spawning; spawn `node <cli.js> run <id> --run-id <runId>` detached with output to `logs/run-<n>.log`; the child rewrites `run.json` with its pid and `status: "running"` (acknowledgement) and deletes it in `finally`. Spawn failure deletes the lock. A lock whose pid is dead, or that stays `starting` for over 60 s, is stale and is removed by the next `run`. Simultaneous starts: only one `wx` create succeeds. `devflow log <id> [--follow]` tails the newest run log; `status` shows `run.json`.

11. **Run loop** in-process: next → execute → record → repeat until `stage: null` or a recorded failure; one JSON line per stage.

## Impact zone

- `src/prompts.ts`
- `src/stages.ts`
- `src/artifacts.ts`
- `src/background.ts`
- `src/snapshot.ts`
- `src/gates.ts`
- `src/git.ts`
- `src/lifecycle.ts`
- `src/store.ts`
- `src/cli.ts`
- `test/**`
- `README.md`
- `docs/SPEC.md`
- `docs/TODO.md`
- `openspec/changes/add-stage-run/**`

## Test plan

- `test/prompts.test.ts`: each template contains its inputs and not forbidden ones (verify: no `## Decisions` text, no facts); language; override; round-2 narrowing with previous verdict.
- `test/artifacts.test.ts`: design checks (missing file, missing zone, `stale_delta`), validation via a fake `openspec` (pass/fail), `off`, `on` without CLI → `openspec_missing`; plan digest ignores checkbox changes but not text changes.
- `test/snapshot.test.ts`: digest changes on content, deletion, new file, mode change (POSIX only), base and gate config; stable otherwise.
- `test/lifecycle.test.ts` additions: `invalidate` to approval/gates without attempts, `evidence_unstable` on the third, manual verify pass needs override.
- `test/run.test.ts` (fake CLIs writing per-stage outputs): medium stops for approval; approve binds plan; plan edit after approval → `plan_changed`; implement → gates → verify pass → DONE; edit between gates and verify → back to gates; verify runs in a worktree (fake verifier edits a source file; user tree unchanged; design reasoning absent from its cwd); rework loops back; `--once`.
- `test/background.test.ts`: `--detach` returns fast; `log` shows output; two simultaneous starts → one `run_active`; stale lock cleaned; spawn failure releases the lock.
- Zone gate test: plan folder in change set with a `src/**` zone passes.
- Real check (task 5.2): one small and one medium task on a scratch repo with real CLIs, recorded in the journal.

## Risks / Trade-offs

- [Prompt quality decides result quality] → prompts are data (overridable); observed runs are the next TODO item.
- [Verify worktree needs dependencies] → `test.setup`; a failed setup makes verify `human: verify_setup_failed`, not a pass.
- [Windows pid reuse can make a dead run look alive] → `starting` timeout plus pid check; `status` marks old locks as `possibly_stale` with a hint.
- [Projects without OpenSpec get an `openspec/` folder] → intended single format; documented.
