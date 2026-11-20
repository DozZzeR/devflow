## 1. Config

- [x] 1.1 Add optional `test.focused` to `ConfigSchema` in `src/config.ts`, with a refinement for exactly one `{files}` and no other placeholder, plus JSDoc. Keep `DEFAULT_CONFIG` without it. Acceptance: project-config / Valid focused template, Template without placeholder, Duplicate or unknown placeholder, Field absent. Verify: the new cases in `test/config.test.ts` pass in a focused run.

## 2. Focused matcher and hook

- [x] 2.1 Create `src/focused.ts` with `FOCUSED_TOKEN`, `MAX_FOCUSED_FILES = 64` and `matchFocused(command, { template, paths })`, as in design decision 2. Write `test/focused.test.ts` first (table of allowed and denied tokens) and see it fail. Acceptance: runners / Focused command with test files allowed, Non-test path rejected, Extra command rejected, Empty file list rejected, Template text is not an allowlist entry. Depends on: none. Verify: focused run of `test/focused.test.ts`.
- [x] 2.2 Extend `ScopeSchema` with optional `focused` and make `decide` allow `matchFocused` matches after the exact `scope.bash` check. All other text is still denied. Acceptance: the runners scenarios from 2.1, plus No focused entry keeps exact matching. Depends on: 2.1. Verify: the new `decide` and `runHook` cases in `test/hook.test.ts` fail on the old code and pass afterwards; the existing hook tests still pass.

## 3. Runner

- [x] 3.1 Add `RunRequest.focused`. Write it into the Claude scope file. Add `Bash(<prefix>:*)` in `claudeInvocation`, and skip `--disallowedTools Bash` when `focused` is set. Extend `validateScope` to reject `focused` on read-only runs. Acceptance: runners / Claude invocation with focused scope, Read-only run with focused scope rejected. Depends on: 2.2. Verify: the new cases in `test/runners.test.ts` pass in a focused run.

## 4. Prompts

- [x] 4.1 Add `focusedCommand` to `PromptInputs`, and `focusedCommand`, `implementTests` and `verifyTests` to `KNOWN`. Render them in `composePrompt` as in design decision 6. Update the implement and small templates to use `{{implementTests}}`. Acceptance: stage-execution / Implement prompt with focused command, Implement prompt without focused command, Placeholder compatibility. Depends on: none. Verify: the new phrase assertions in `test/prompts.test.ts` fail on the old templates and pass afterwards.
- [x] 4.2 Update the verify template to use `{{verifyTests}}` and require the "confirmed by gates" / "checked additionally" evidence labels. Keep the severity, verdict-rule and `ROUND2_RULE` text byte-identical. Acceptance: stage-execution / Verify prompt with focused command, Severity rubric preserved, Verify prompt without focused command. Depends on: 4.1. Verify: `test/prompts.test.ts` asserts the new rules and the unchanged rubric strings in rounds 1 and 2.

## 5. Stages

- [x] 5.1 In `src/stages.ts`, read `test.focused` from the trusted config (`gateConfig`) in the implement/small branch and in `runVerify`. Pass `focused` to `runModel` → `runRole` and `focusedCommand` to the prompt. Drop `test.command` from `bash` when focused is set (implement keeps `generate`; verify gets `[]`). Gates do not change. Acceptance: stage-execution / Implement with focused configured, Verify with focused configured, Working-copy focused ignored, Focused not configured. Depends on: 3.1, 4.2. Verify: the new request-capture cases in `test/run.test.ts` pass in a focused run.

## 6. Repository command and docs

- [x] 6.1 Add `scripts/test-focused.mjs` (validate args, map them to `dist/**.js`, locate the compiler by resolving `typescript/package.json` with `createRequire` and joining its directory with the manifest's `bin.tsc` entry as in design decision 7, compile with `process.execPath <tscPath> -p tsconfig.json`, run `node --test` on the mapped files) and set `test.focused` to `node scripts/test-focused.mjs {files}` in `.devflow/config.json`. Acceptance: project-config / Repository focused command. Depends on: 1.1. Verify: `node scripts/test-focused.mjs test/hook.test.ts` compiles without `ERR_PACKAGE_PATH_NOT_EXPORTED` and runs only that file; the `test/focused.test.ts` cases for a bad argument (non-zero exit) and for the config value pass.
- [x] 6.2 Document `test.focused`, the focused hook allowance and the new prompt placeholders and rules in `README.md`, `docs/SPEC.md` and `docs/DEVELOPMENT.md`, and add JSDoc for the new exports. Acceptance: all scenarios above are described consistently. Depends on: 2.2, 3.1, 4.2, 5.1, 6.1. Verify: review the docs diff against the spec deltas; the gates run the full suite.
