# Design

## Context

Lifecycle, config and runners exist (`openspec/specs/task-lifecycle`, `project-config`, `runners`). The lifecycle already has a `gates` stage recorded by `devflow complete <id> gates ok|fail`. Lessons that shape this change are in `docs/TODO.md` ("Известные грабли окружения"): results depend on the environment, and an environment failure must never look like a meaningful result. A Codex plan review (`.devflow/runs/add-gates/plan-review.md`, REWORK, 7 findings) shaped decisions 2, 3, 4, 5, 6, 7, 8 and 10.

## Goals / Non-Goals

**Goals:**
- Gates that need only git and the project's own test command; no model calls.
- Never touch the user's working tree, index or branches during the rollback check.

**Non-Goals:**
- Binding verify verdicts to the diff hash (comes with stage prompts and `devflow run`).
- Reading the zone from OpenSpec change folders automatically (adapter change); `--from-design` covers it manually.
- Per-test evidence and mutation testing beyond the suite-level rollback check.

## Decisions

1. **Git via the `git` CLI** through the existing process helper. `rev-parse --show-toplevel` and `--show-prefix` map the project directory (which may be a subdirectory) to repo paths; all git paths are converted to project-relative and filtered to the project. Commands use `-z` output: `diff --name-status -z --find-renames <base> -- <prefix>`, `ls-files --others --exclude-standard -z -- <prefix>`, `worktree add --detach <tmp> <base>`, `worktree remove --force <tmp>`. Alternative: a JS git library. Rejected: new dependency, weaker on Windows.

2. **Change set** = name-status entries (both paths for renames) plus untracked, non-ignored files, minus `.devflow/runs/**` and `.devflow/logs/**` only. `.devflow/config.json` counts, so a role cannot silently change the test command or limits. Writes into git-ignored paths (for example `node_modules/`) are invisible to git; accepted limitation, noted in docs/TODO.md.

3. **Rollback check by copying files.** In the temp worktree at the base (project dir = worktree + prefix): setup (if any), baseline run; copy or delete the test subset, run, expect red; copy the rest, run setup again if any changed path matches `test.setup_inputs`, run, expect green. Copying avoids `git apply` failures and keeps the user's index untouched. Removal in `finally` with up to 3 retries (Windows file locks from surviving descendants); persistent failure → `blocked: cleanup_failed` with the path; only that worktree is removed, no repository-wide prune.

4. **Test command execution.** The configured command runs in the platform shell with the parent environment (the user's own tests, no model involved): Windows `cmd.exe /d /s /c "<command>"` with `windowsVerbatimArguments` (Node's default quoting would mangle quoted commands), POSIX `/bin/sh -c`. Output goes to `.devflow/runs/<id>/logs/gate-<name>-<n>.log` through the log writer. Timeout from `test.timeout_seconds`; timeout or kill → `blocked: test_run_error`.

5. **Three outcomes.** `pass | fail | blocked`. `blocked` covers every "could not check" case so the environment never masquerades as a verdict on the code.

6. **Reducer events.** New event `gates { outcome, gate?, reason? }`. `pass` → as `ok`, resets `counters.gatesFailedInARow`. `fail` → consumes an implement attempt, increments the counter, then escalation is evaluated before limits (escalation resets counters and attempts; on `complex` → `HUMAN` with the trigger). `blocked` → `HUMAN` with the reason, nothing else changes. `devflow complete <id> gates ok` requires `--override "<reason>"` and is recorded as a human override; `fail` stays allowed.

7. **Escalation keeps the working tree.** docs/SPEC.md §4.4 planned to stash the diff as `draft.patch` and reset the tree on small → medium. That is destructive and is dropped: the tree stays, explore/design see the existing changes. SPEC §4.4 is updated accordingly.

8. **State schema 2.** Optional `base`, `zone`, `counters { gatesFailedInARow, reworks }`. Schema 1 is upgraded in memory; save writes 2. Upgraded tasks have no base → gates `blocked: no_base` until `devflow base <id> <commit>`.

9. **Zone parsing from design.** Heading `## Impact zone` (case-insensitive) up to the next heading; `- <glob>` items, backticks stripped; same validation as write globs.

10. **Red exit codes.** Default red = any non-zero exit except timeout/kill. Projects whose runner separates "tests failed" from "could not run" (pytest: 1 vs 2–5) can set `test.red_exit_codes: [1]`; other codes then become `blocked`. Suite-level red cannot prove each changed test is red; per-file rollback is future work (docs/TODO.md).

## Impact zone

- `src/git.ts`
- `src/gates.ts`
- `src/zone.ts`
- `src/proc.ts`
- `src/lifecycle.ts`
- `src/store.ts`
- `src/config.ts`
- `src/cli.ts`
- `test/**`
- `README.md`
- `docs/SPEC.md`
- `docs/TODO.md`
- `.devflow/config.json`
- `openspec/changes/add-gates/**`

## Test plan

- `test/git.test.ts` (temp git repos): change set with modified, added, deleted, renamed, untracked and ignored files; `.devflow/runs` excluded but `.devflow/config.json` included; names with spaces; project in a subdirectory of the repo.
- `test/zone.test.ts`: parsing `## Impact zone` (backticks, stops at next heading, missing section); zone pass/fail lists outsiders; `no_zone` blocked for medium vs warning for small.
- `test/rollback.test.ts` (temp git repo, test command `node check.js`): real regression → pass; passes at base → `tests_check_nothing`; no test files → `no_tests`; broken baseline → `blocked: baseline_failed`; setup runs, and again when a `setup_inputs` file changed; `red_exit_codes` makes other codes `blocked`; timeout → `blocked`; `git status --porcelain` identical before/after; temp worktree gone; quoted test command works on Windows.
- `test/lifecycle.test.ts` additions: gates pass/fail/blocked events; escalation before limits; zone violation; `rework_repeated`; HUMAN on complex; counter resets; override required for manual gates ok; schema-1 upgrade.
- `test/cli-gates.test.ts`: `start` records base and `--zone`; `zone --from-design`; `base`; `gate all` records only when `gates` is next; single gate leaves state unchanged; stop at first non-pass; `complete gates ok` without override refused.

## Risks / Trade-offs

- [Baseline needs dependencies in the worktree] → `test.setup` (re-run when manifests change); failures are `blocked`, never a misleading red.
- [Writes into git-ignored paths are invisible to the zone gate] → accepted; listed in docs/TODO.md.
- [Rollback is slow: up to three suite runs plus setup] → run last in `all`; can be run alone.
- [Test command gets the parent environment] → intentional (user's own tests, no model); documented in README.
- [Projects without git] → `start` works, gates are `blocked: no_git`; documented.
