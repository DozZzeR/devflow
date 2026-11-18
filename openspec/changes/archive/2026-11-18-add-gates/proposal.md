# Proposal

## Why

Roles can now run, but nothing checks their work mechanically. The runner review showed why this matters: write scope inside a CLI is only as strong as the CLI's own settings, and a green test suite can be green because the tests check nothing (the timeout test passed after 60 s instead of 2). Gates are the deterministic layer that does not depend on any model or CLI setting: they look at the git diff and at test results, and they decide whether the gates stage passes. They are also where automatic tier escalation (docs/SPEC.md §4.4) gets its signals.

## What Changes

- Task base: `devflow start` records the current git commit as the task base; gates compare against it.
- Impact zone per task: globs set at start (`--zone`, repeatable), or read from a `## Impact zone` section of a design file (`devflow zone <id> --from-design <path>`).
- `devflow gate <id> [zone|rollback|tests|all]`:
  - **zone**: every changed, added, deleted or untracked file since the base is inside the zone (plus devflow's own state);
  - **rollback**: in a temporary git worktree at the base, the baseline suite passes, then with only the changed test files it fails, then with the production changes too it passes; tests that pass without the production change are reported as checking nothing;
  - **tests**: the project's test command passes in the working tree.
- When the task's next stage is `gates`, `devflow gate <id>` (all gates) records the gates outcome itself; single-gate runs are informational.
- Automatic escalation: consecutive gate failures reaching `limits.escalate_after`, or a zone violation, raise the tier by one with a recorded reason; two verify reworks raise medium to complex.
- Optional `test.setup` command run in the temporary worktree before the rollback check (for installs such as `npm ci`).

## Capabilities

### New Capabilities

- `gates`: deterministic checks of a task's changes against its base: zone, rollback check, tests; their results and how they feed the lifecycle.

### Modified Capabilities

- `task-lifecycle`: tasks record a git base and an impact zone; gates outcomes come from `devflow gate`; automatic escalation triggers.
- `project-config`: optional `test.setup`.

## Impact

- New `src/git.ts`, `src/gates.ts`, `src/zone.ts`; changes to `src/lifecycle.ts`, `src/config.ts`, `src/cli.ts`, `src/store.ts`.
- Requires git for `start`-recorded bases and for gates; tasks started outside a git repository can still run, but gates fail with `no_git`.
- The rollback check runs the project's test command up to three times in a temporary worktree; it is the slowest gate.
- Task state schema gains fields; schema version moves to 2 with an automatic upgrade of version-1 files on load.
