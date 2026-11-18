# Design

## Context

Lifecycle, config and runners exist (`openspec/specs/task-lifecycle`, `project-config`, `runners`). The lifecycle already has a `gates` stage recorded by `devflow complete <id> gates ok|fail`. Lessons that shape this change are in `docs/TODO.md` ("Известные грабли окружения"): results depend on the environment, and an environment failure must never look like a meaningful result.

## Goals / Non-Goals

**Goals:**
- Gates that need only git and the project's own test command; no model calls.
- Never touch the user's working tree, index or branches during the rollback check.

**Non-Goals:**
- Binding verify verdicts to the diff hash (comes with stage prompts and `devflow run`).
- Reading the zone from OpenSpec change folders automatically (adapter change); `--from-design` covers it manually.
- Mutation testing beyond the rollback check.

## Decisions

1. **Git via the `git` CLI** through the existing process helper (`launch`, allowlisted env plus `GIT_*` not passed). Commands: `rev-parse --verify HEAD`, `diff --name-status -z --find-renames <base>`, `ls-files --others --exclude-standard -z`, `worktree add --detach <tmp> <base>`, `worktree remove --force <tmp>`, `worktree prune`. `-z` output avoids quoting problems with unusual file names. Alternative: a JS git library. Rejected: new dependency, worse Windows behaviour.

2. **Change set** = union of name-status entries (for renames both old and new path) and untracked files, minus `.devflow/**`. Computed fresh on every gate run; never cached.

3. **Rollback check by copying files, not by patches.** In the temp worktree at the base: run `test.setup` if set, then the baseline. Then copy (or delete) the test-file subset from the working tree, run tests, expect non-zero. Then copy the rest, run tests, expect zero. Copying avoids `git apply` failures on binary or whitespace edge cases and keeps the user's index untouched. Temp worktrees live under the OS temp dir and are removed in a `finally`, followed by `git worktree prune`.

4. **Test command execution.** The test command is the user's own (from config), run through the platform shell (`cmd.exe /d /s /c` or `/bin/sh -c`) with the parent environment, because tests legitimately need project env (database URLs etc.). This differs from model runners on purpose: no model sees this environment. Output goes to `.devflow/runs/<id>/logs/gate-<name>-<n>.log` via the existing log writer (redacted). Timeout from `test.timeout_seconds`; kill and teardown reuse `launch`.

5. **`devflow gate` and the lifecycle.** A new event `gates(result)` in the reducer replaces `complete gates` internally: it carries which gate failed, so the reducer can apply escalation triggers. `devflow complete <id> gates ok|fail` keeps working (treated as a gates result without a failing gate name). Order for `all`: zone (cheapest), tests, rollback (slowest).

6. **Escalation in the reducer.** State gains `counters.gatesFailedInARow` and `counters.reworks`. Triggers per spec; escalation reuses the existing `escalate` path with the trigger as reason; on `complex` the task goes to `HUMAN` with the same reason. Counters reset on gates pass and on any tier change.

7. **State schema 2.** New optional fields `base`, `zone`, `counters`. Loader accepts schema 1 and maps it to 2 in memory; save writes 2. Unknown versions still fail.

8. **Zone parsing from design.** Find a heading line `## Impact zone` (case-insensitive), take following lines up to the next heading, collect `- <glob>` items (backticks stripped). Same validation as write globs (relative, no `..`, no drive prefix).

## Impact zone

- `src/git.ts`
- `src/gates.ts`
- `src/zone.ts`
- `src/lifecycle.ts`
- `src/store.ts`
- `src/config.ts`
- `src/cli.ts`
- `test/**`
- `README.md`
- `docs/SPEC.md`
- `docs/TODO.md`
- `openspec/changes/add-gates/tasks.md`

## Test plan

- `test/git.test.ts` (temp git repos): change set with modified, added, deleted, renamed, untracked and ignored files; `.devflow/` excluded; names with spaces.
- `test/zone.test.ts`: parsing `## Impact zone` (backticks, stops at next heading, missing section); zone gate pass/fail lists outsiders; `no_zone` fail vs small-task warning.
- `test/rollback.test.ts` (temp git repo with a tiny `node check.js` test command): real regression test → pass; test that passes at base → `tests_check_nothing`; no test files → `no_tests`; broken baseline → `baseline_failed`; `test.setup` runs; user working tree and `git status` unchanged; temp worktree removed.
- `test/lifecycle.test.ts` additions: gates result events, consecutive failure escalation, zone violation escalation and HUMAN on complex, rework_repeated, counter resets; schema-1 upgrade.
- `test/cli-gates.test.ts`: `start` records base and `--zone`; `zone --from-design`; `gate all` advances only when `gates` is next; single gate leaves state unchanged; stop at first failure.

## Risks / Trade-offs

- [Baseline needs dependencies in the worktree] → `test.setup`; failures are `baseline_failed`, never a misleading red.
- [Rollback is slow: up to three suite runs] → run last in `all`; can be run alone; future: test-path filtering.
- [Test command gets the parent environment] → intentional (user's own tests, no model); documented in README.
- [Projects without git] → `start` works, gates fail `no_git`; documented.
