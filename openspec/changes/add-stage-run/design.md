# Design

## Context

Lifecycle, runners (`runRole`), gates and OpenSpec 2.1.0 in the repo exist (`openspec/specs/*`). Until now every role run was assembled by hand (prompt files in a scratch folder, `exec-role` flags, manual `complete`). The verify rule accepted on 2026-11-18 (two rounds; round 2 only high findings and regressions) is in `docs/TODO.md`.

## Goals / Non-Goals

**Goals:**
- One command that drives a task through its stages with the contracts in the specs.
- Prompts that are short, stage-specific, and do not leak other roles' reasoning into verify.
- Watchable long runs without MCP.

**Non-Goals:**
- MCP server and plugins (next changes); they will call the same run loop.
- Reading access control: models can still open any file in the repo; "visibility" means what the prompt hands them and tells them to use.
- Automatic triage of the tier (SPEC §4.4 triage) — tier stays manual or default.

## Decisions

1. **Prompts as TypeScript string templates** (`src/prompts.ts`) with `{{placeholders}}`, not `.md` files copied at build time (tsc does not copy assets). Override: `.devflow/prompts/<stage>.md` with the same placeholders. Each template states the stage's job, the exact output files and format, the write scope in words (the runner enforces it), and "write in {{language}}".

2. **Inputs are inlined, not referenced.** The prompt contains the needed text (task, spec deltas, test plan, change set list, gate summary). Explore, design and implement also get file paths to read on demand. Verify gets only inlined text plus permission to read source files of the change set and run the test command — so it never needs `design.md`.

3. **Stage → runRole mapping** (`src/stages.ts`): role name, write globs, allowed shell commands (`[test.command]` for implement and small), expected outputs, timeout (`--timeout` or 30 min). Implement's write scope = task zone + `openspec/changes/<id>/tasks.md`. Verify gets write scope `.devflow/runs/<id>/verdict.md`; with the codex runner this is `sandbox` (repo-wide), and the zone/diff hash check catches stray edits.

4. **Design post-checks** (`src/artifacts.ts`): required files exist; `## Impact zone` parses (reuse `parseImpactZone`); validation per `openspec.cli` (`auto` → resolve `openspec`, also `npx --no-install openspec` when `node_modules/.bin/openspec` exists; `on` → required; `off` → skip). Zone is written into task state with a `zone` history entry.

5. **Verdict binding.** Change-set hash = SHA-256 over sorted `path\0sha256(content or "<deleted>")`. Stored in task state with the verdict (`lastVerdict.hash`). Before recording `pass`, and before `run` declares `DONE`, the hash is recomputed; mismatch → `stale_verdict`: task returns to the gates stage (new event `invalidate_verdict`), counted neither as rework nor as failure.

6. **Verify rounds.** Round = number of completed verify runs for the task + 1. Round ≥ 2 adds the previous `verdict.md` (archived as `verdict-round<n>.md` before the next run) and the narrowing instruction.

7. **Run loop** in-process: `next` → execute → record → repeat. Stops on `stage: null` (approval, HUMAN, done) or a recorded `fail`. Every executed stage prints a JSON line.

8. **Background runs.** `--detach` spawns `node <cli.js> run <id> --from-detach <run-id>` with `detached: true`, stdio to `.devflow/runs/<id>/logs/run-<n>.log`, and writes `.devflow/runs/<id>/run.json` `{ runId, pid, startedAt }` exclusively (`wx`). Active = `run.json` exists and the pid is alive; the child removes `run.json` on exit. A stale `run.json` (dead pid) is cleaned by the next `run`. `devflow log <id> [--follow]` prints the latest run log and, with `--follow`, polls until the run ends. Allowlisted environment for the background process is the parent's (it is devflow itself, not a model); model runs inside still use the runner allowlist.

## Impact zone

- `src/prompts.ts`
- `src/stages.ts`
- `src/artifacts.ts`
- `src/background.ts`
- `src/lifecycle.ts`
- `src/store.ts`
- `src/cli.ts`
- `test/**`
- `README.md`
- `docs/SPEC.md`
- `docs/TODO.md`
- `openspec/changes/add-stage-run/**`

## Test plan

- `test/prompts.test.ts`: each stage template contains its inputs and not forbidden ones (verify: no `## Decisions` text, no facts); language placeholder; project override; round-2 verify includes previous verdict and narrowing instruction.
- `test/artifacts.test.ts`: design checks (missing file, missing zone, validation via a fake `openspec` on PATH: pass/fail; `off`; `on` without CLI → `openspec_missing`); zone written to state.
- `test/verdict.test.ts`: first-line parsing incl. unreadable; change-set hash stable and sensitive to content, deletion and new files; stale pass → `stale_verdict` and back to gates.
- `test/run.test.ts` (fake `claude`/`codex` that write the expected files per stage, driven by env and prompt markers): medium task runs explore+design and stops for approval; after approve, implement → gates → verify pass → DONE; `--once`; failing stage stops; verify rework loops back.
- `test/background.test.ts`: `--detach` returns fast with run id; `log` shows output; second run → `run_active`; stale `run.json` cleaned.
- Real check (task 5.x): one small and one medium task on a scratch repo with real `codex`/`claude`, recorded in `docs/TODO.md` run journal.

## Risks / Trade-offs

- [Prompt quality decides result quality] → prompts are data (overridable), observed runs are the next TODO item.
- [Codex verify can write anywhere in the repo] → reported `sandbox`; diff hash + zone gate catch it.
- [Background process outlives its terminal] → that is the point; `run.json` + pid check; Windows pid reuse could make a dead run look alive → also compare process start time when available, otherwise show `possibly_stale`.
- [Projects without OpenSpec get an `openspec/` folder] → intended single format; documented.
