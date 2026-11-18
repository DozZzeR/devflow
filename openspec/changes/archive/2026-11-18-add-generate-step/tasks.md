# Tasks: add-generate-step

## 1. Configuration

- [x] 1.1 Rework the `build` section in `src/config.ts`: `outputs` becomes `.optional()` without a default; the `superRefine` reports `build.generate` whenever `outputs` was supplied (including `[]`) and `generate` is absent; the glob check strips leading `./` segments and rejects any glob starting with `.devflow` (plain prefix), plus the existing empty / absolute / drive letter / `\` / `..` rules. Update consumers to read `build?.outputs ?? []`. Verified by the Build settings cases in `test/config.test.ts`, including `{ "outputs": [] }`, `.devflow-cache/**`, `.devflow*/**`, `./.devflow/runs/**`, and the still-accepted `./plugins/**` and `src/.devflow-notes/**`.
- [x] 1.2 Set `"build": { "generate": "npm run build:plugins", "outputs": ["plugins/**"] }` in `.devflow/config.json`. Verified by a `test/config.test.ts` case that loads the repository config and checks both values.

## 2. Generate helper and gates

- [x] 2.1 Add `runGenerate(ctx, cwd, label)` to `src/gates.ts`. It returns `undefined` without `build.generate`, and otherwise calls `runCommand` (same env, timeout, and log). Verified through the implement, rollback, and verify tests below.
- [x] 2.2 In `zoneGate`, use `task.zone ∪ config.build.outputs` when `task.zone` is non-empty. Verified by the "Outputs join the zone" cases in `test/gates.test.ts`.
- [x] 2.3 Strengthen the "Rollback worktree regenerates" fixture in `test/gates.test.ts`: `gen.mjs` exits 1 unless the change's test file is present in its cwd with the `// gen-marker` line, then writes `out/bundle.txt` from `src/value.txt`. Keep the stale-bundle comparison, the no-`build` failure case, the always-failing generate case, and the cleanup checks. Verified by the fixture passing with generate (proving step 2 runs after the test files are applied) and failing `tests_fail_with_change` without it.
- [x] 2.4 In `src/glob.ts` `globToRegExp`, strip every leading `./` segment (`.replace(/^(?:\.\/)+/, "")` after the `\` → `/` conversion) instead of only one, matching the validator in `src/config.ts`. Extend the "Outputs join the zone" fixture in `test/gates.test.ts`: outputs `././plugins/**` and `./plugins/**` pass without listing `plugins/x/index.js`, and a zone of `././src/**` passes for `src/a.ts`. Add a `test/config.test.ts` case that `["././plugins/**"]` with a generate command loads and is reported as written. Verified by these cases passing, and by the `././plugins/**` case failing against the old one-prefix regex.

## 3. Implement stage

- [x] 3.1 In `src/stages.ts` `case "implement"`, after a successful model run that is neither blocked nor a plan conflict, run `runGenerate` in the project root with the trusted `gateConfig` config. Record `implement ok` only on success. Verified by the "Generate runs after implement" and "Trusted command" cases in `test/run.test.ts`.
- [x] 3.2 On generate failure, write `.devflow/runs/<id>/generate-failure.md` (command, exit code or timeout, 80-line log tail), record `implement fail`, and report reason `generate_failed`. Verified by the "Failure feeds back" case in `test/run.test.ts` (exit 1 and timeout).
- [x] 3.3 Strengthen the retry test in `test/run.test.ts`: the retry's fake implementer checks at start that `generate-failure.md` is already gone (failing or writing a marker the test asserts absent otherwise), the saved prompt of that attempt still contains `bundle error`, and a later prompt does not. Keep the removal in `src/stages.ts` before the model launch. Verified by this test passing, and by it failing if the removal is moved after the model run.
- [x] 3.4 Add trusted `build.generate` to the implement and small `bash` list, and list `build.outputs` as generated paths in the implement prompt's impact zone block. Verified by the "Implementer may regenerate" and prompt-listing cases in `test/run.test.ts`.

## 4. Verify stage

- [x] 4.1 In `runVerify`, run `runGenerate` in `wt.projectDir` after setup and before the verifier. A failure sets `verify_generate_failed`. Verified by the "Verify copy regenerates" cases in `test/run.test.ts`.

## 5. Docs, bundles and full suite

- [x] 5.1 Update the README settings paragraph so it also states that `build.outputs` requires `build.generate` and that output globs may not start with `.devflow`. Verified by reading `README.md`.
- [x] 5.2 Run `npm run build:plugins` again after the `src/glob.ts` change so that `plugins/**` matches `src`. Verified by `test/plugins.test.ts` passing (or, if esbuild hits the access-denied error again, by reporting that output).
- [ ] 5.3 Run `npm test`. Verified when the whole suite is green; any remaining failures unrelated to this change (esbuild access, `EPERM` cleanup, `test/proc.test.ts` grandchild) are reported with their output.
