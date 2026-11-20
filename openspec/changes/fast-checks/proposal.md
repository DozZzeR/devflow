## Why

Implement, small and verify roles currently have only the full test command (`test.command`, `npm test` here). They rerun the whole suite several times per attempt, even though the gates run the full suite against the exact snapshot anyway. That costs time and money and adds no evidence. Roles need a cheap, scoped way to run only the tests they touch. The scope enforcement must stay fail-closed: the Claude PreToolUse hook allows shell text only by exact match today.

## What Changes

- Config: new optional `test.focused`, a command template that contains exactly one `{files}` placeholder. devflow fills it with space-separated project-relative test files that match `test.paths`. The template is read from the trusted (base) config, like `build.generate`.
- Scope: `Scope` (the file the hook reads) gains an optional `focused` entry `{ template, paths }`. The hook `decide` allows a Bash command when it is an exact `scope.bash` entry, or when it is the focused template filled with one or more safe file tokens that each match `scope.focused.paths`. Everything else is still denied: extra commands, separators, quotes, globs, `..`, absolute paths, option-like tokens, non-test paths and an empty file list.
- Runners: `RunRequest` gains `focused`. The Claude runner writes it into the scope file and adds a `Bash(<prefix>:*)` allow rule; the hook stays the authority. `validateScope` rejects `focused` on a read-only run.
- Stages: implement/small and verify pass the trusted `test.focused` to the role (scope and prompt). The full `test.command` stays in the implement/small Bash allowlist only when no focused command is configured. When one is configured, verify gets only the focused command.
- Prompts: new placeholders `{{focusedCommand}}`, `{{implementTests}}` and `{{verifyTests}}`.
  - Implement/small: write the regression test first, run it focused and see it fail for the expected reason, then make it and the related tests pass with focused runs. Do not run the full suite; the gates do.
  - Verify: gate results are for the exact snapshot under review (devflow re-checks the hash before it accepts PASS). Do not rerun the full suite. Run focused tests only for a concrete question the gates did not answer. In the verdict, keep evidence "confirmed by gates" apart from evidence "checked additionally". The severity rubric and the verdict rule do not change.
- New `scripts/test-focused.mjs` for this repository. It maps `test/<name>.test.ts` to `dist/test/<name>.test.js`, compiles with the local TypeScript, and runs `node --test` on the mapped files. `.devflow/config.json` sets `"focused": "node scripts/test-focused.mjs {files}"`.
- Gates do not change. They still run the full `test.command`.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `project-config`: optional `test.focused` template and its validation.
- `runners`: focused shell scope in the Claude hook and the runner.
- `stage-execution`: focused scope and test rules in the implement/small and verify prompts.

## Impact

- Code: `src/config.ts`, `src/hook.ts`, `src/runners.ts`, `src/stages.ts`, `src/prompts.ts`, new `src/focused.ts` (shared template/token matcher), new `scripts/test-focused.mjs`.
- Config: `.devflow/config.json` of this repository.
- Tests: `test/config.test.ts`, `test/hook.test.ts`, `test/runners.test.ts`, `test/prompts.test.ts`, `test/run.test.ts`, new `test/focused.test.ts`.
- Docs: `README.md`, `docs/SPEC.md`, `docs/DEVELOPMENT.md` where they describe config, role shell scope and prompts.
- Compatibility: configs without `test.focused` keep today's behaviour. A project prompt override that uses only the existing placeholders keeps working. Codex and command runners do not enforce shell scope, so for them focused runs are a prompt rule only, as the full command is today.
- Evidence: `test.focused` is part of the hashed config, so changing it changes the snapshot. That is intended.
