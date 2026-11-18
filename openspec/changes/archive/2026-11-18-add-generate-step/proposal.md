# Add a generate step for derived files

## Why

Some projects commit generated files that tests check for freshness. In this repository, `plugins/**` is built from `src` and `skills` by `npm run build:plugins`, and `test/plugins.test.ts` fails when the committed bundles are stale. Today devflow runs no build between implement and the gates. An implementer that changes `src` without rebuilding fails the tests gate, and the generated paths fall outside the impact zone. The rollback gate and verify also copy the changed paths into a temporary worktree without rebuilding, so freshness tests there see a mix of old and new files. These failures come from a missing build step, not from wrong code, and each one costs an implement attempt.

## What Changes

- The config gains an optional, strictly validated `build` section: `build.generate` (a shell command) and `build.outputs` (project-relative globs of the files it produces). Any explicit `build.outputs`, even `[]`, requires `build.generate`. An output glob may not start with `.devflow` (checked after stripping leading `./`), be absolute, or contain `\` or `..`.
- After a successful implement (or small) model run, devflow runs `build.generate` in the project root before the gates. It uses the same shell runner as the test command: same environment, `test.timeout_seconds`, process-tree termination, and a task log. The command and output globs are read from the trusted gate config (the config committed at the task base).
- If generate fails (non-zero exit, timeout, or kill), devflow records `implement fail` with reason `generate_failed` and writes `.devflow/runs/<id>/generate-failure.md` with the log tail. The next implement prompt includes that file, the same way gate failures are fed back.
- The `build.outputs` globs join the task's impact zone automatically. The zone gate accepts them, and the implement prompt lists them as generated paths. Glob matching ignores every leading `./` segment, the same way validation does, so `././plugins/**` matches `plugins/x/index.js`.
- The rollback gate runs `build.generate` in its temporary worktree after each time it applies changed paths. Verify runs it in its copy after applying the change set and setup. A failure there is `blocked` (`generate_failed`) or `verify human` (`verify_generate_failed`).
- The implementer may run `build.generate` in addition to the test command.
- This repository's `.devflow/config.json` sets `build.generate` to `npm run build:plugins` and `build.outputs` to `["plugins/**"]`. The README documents the settings.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `project-config`: new `build` section (`build.generate`, `build.outputs`) with validation.
- `stage-execution`: generate step after implement, failure feedback, implementer shell scope, and regeneration in the verify copy.
- `gates`: the zone gate accepts `build.outputs`, and the rollback worktree regenerates after paths are applied.

## Impact

- Code: `src/config.ts` (schema), `src/stages.ts` (implement and verify), `src/gates.ts` (zone and rollback), `src/glob.ts` (leading `./` normalization, shared by every glob matcher).
- Config and docs: `.devflow/config.json`, `README.md`.
- Generated bundles: `plugins/**` must be rebuilt because `src` changes.
- Tests: `test/config.test.ts`, `test/run.test.ts`, `test/gates.test.ts`.
- Compatibility: configs without `build` behave exactly as before. The repository setting applies to tasks whose base commit contains it, because the generate command is read from the trusted base config.
