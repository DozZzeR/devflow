## Context

Roles get the full `test.command` in their prompt and, on Claude, in their Bash allowlist (`src/stages.ts` implement branch: `bash = [config.test.command]`, verify: `bash: [config.test.command]`). The Claude PreToolUse hook (`src/hook.ts` `decide`) allows Bash only by exact match with a `scope.bash` entry. The gates (`src/gates.ts`) run the full suite against the snapshot, and `runVerify` accepts PASS only if `snapshotDigest` has not changed. Full suite runs inside roles therefore repeat evidence the gates already produce.

This repository builds tests with `tsc` into `dist/test/*.test.js` (`tsconfig.json`: `rootDir: "."`, `outDir: "dist"`, include `src/**/*.ts`, `test/**/*.ts`). Source test paths (`test/x.test.ts`) match `test.paths`, but the runnable files are under `dist/`.

## Decisions

1. **Config field.** `test.focused: z.string().min(1).optional()` with a refinement: `{files}` appears exactly once, and no other `{name}` placeholder is present. `DEFAULT_CONFIG` stays without `focused`, so init does not write it. The field is included in `configHash` automatically.

2. **Template filling is a shared pure module `src/focused.ts`.**
   - `FOCUSED_TOKEN = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/`, `MAX_FOCUSED_FILES = 64`.
   - `matchFocused(command, { template, paths }): string[] | undefined`:
     - Split the template at `{files}` into `prefix` and `suffix` (both literal).
     - The trimmed command must start with `prefix` and end with `suffix`, and the middle part must be a non-empty list of tokens separated by single spaces.
     - Each token must match `FOCUSED_TOKEN`. Its `/`-segments must not include `.`, `..` or an empty segment, and it must satisfy `matchesAny(token, paths)` from `src/glob.ts`.
     - Return the files, or `undefined` if anything fails.
   - The character class excludes whitespace other than the separator, quotes, `$`, backticks, `;`, `&`, `|`, `<`, `>`, `(`, `)`, `*`, `?`, `[`, `]`, `{`, `}`, `~` and `\`. So no shell metacharacter, glob or Windows separator can reach the shell from a token. A leading `-` is excluded, so a token cannot become an option.
   - The template itself is trusted text from the base config. Shell characters in its prefix (for example `npx tsc -p . && node --test`) are matched literally and are acceptable.
   - Paths use `/` only. On Windows the Claude Bash tool runs a POSIX shell, so forward slashes are correct there too.
   - This is a matcher, not a renderer: devflow never builds the command itself, because the role chooses the files.

3. **Hook.** `ScopeSchema` gains `focused: z.strictObject({ template: z.string(), paths: z.array(z.string()) }).optional()`. In `decide`, Bash is allowed if `scope.bash.includes(command)` (unchanged) or `scope.focused && matchFocused(command, scope.focused)`. Otherwise the existing deny reason is returned. The raw template is never an allowlist entry: it fails the token check because of `{`. The hook still fails closed on parse errors.

4. **Runner.**
   - `RunRequest.focused?: { template: string; paths: string[] }`.
   - The Claude case writes it into the scope JSON.
   - `claudeInvocation` adds `Bash(<prefix.trim()>:*)` so that Claude's own permission layer under `dontAsk` does not deny the command before the hook can allow it. The hook stays the strict authority. `--disallowedTools Bash` is added only when `bash` is empty and `focused` is absent.
   - `validateScope(write, bash, focused?)` treats `focused` like a shell permission: it is not allowed on read-only runs.
   - Codex and command runners ignore `focused` (sandbox/advisory scope, as the full command is today).

5. **Stages.**
   - `runModel` takes `extra.focused` and forwards it to `runRole`. It also puts `focusedCommand` into the prompt inputs.
   - The implement branch reads the template from `trusted.test.focused` (`gateConfig`), not from the working config. Then `bash = focused ? [] : [config.test.command]`, plus `generate`, and `focused = { template, paths: trusted.test.paths }`.
   - `runVerify` already uses the trusted `config` from `gateConfig`. There, `bash: focused ? [] : [config.test.command]`.
   - The prompt's `testCommand` stays `config.test.command`, for wording and compatibility.
   - Gates do not change.

6. **Prompts.**
   - `PromptInputs.focusedCommand?: string`. `KNOWN` gains `focusedCommand`, `implementTests` and `verifyTests`. `composePrompt` renders the two rule texts from `testCommand` and `focusedCommand`:
     - `implementTests` with focused: "Testing: write the new regression test first. Run only it with the focused command `<focused>` (replace {files} with the test file paths, space-separated) and see it fail for the expected reason on the old code. Then make it and the related tests pass with focused runs. Do not run the full suite `<testCommand>`; the gates run it."
     - `implementTests` without focused: the same TDD steps, using `<testCommand>`.
     - `verifyTests` with focused: "The gate results below are for the exact snapshot you check; devflow re-checks the snapshot hash before it accepts PASS. Do not rerun the full suite `<testCommand>`. Run `<focused>` only for a concrete question the gates did not answer. In the verdict, mark each piece of evidence as 'confirmed by gates' or 'checked additionally'."
     - `verifyTests` without focused: the same text, but allowing `<testCommand>` only for a concrete question.
   - The implement template replaces "You may run the test command: {{testCommand}}" with `{{implementTests}}`; small likewise; verify replaces "...and run: {{testCommand}}" with "You may read the changed files." plus `{{verifyTests}}`.
   - The severity and verdict-rule lines and `ROUND2_RULE` stay byte-identical. The verdict-format line adds the requirement that the evidence column uses the two labels.
   - Placeholder names are exported as constants, so tests compare against them instead of copying strings.

7. **Repository command.**
   - `scripts/test-focused.mjs` (no dependencies) validates every argument: relative, `/`-separated, ends with `.ts`, and under `src/` or `test/`.
   - It maps each argument to `dist/<path>.js`.
   - It locates the compiler through the package manifest, not through a subpath import. The installed `typescript` package has an `exports` map that exposes `./package.json` but not `./bin/tsc`, so `require.resolve("typescript/bin/tsc")` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Instead:
     - `const require = createRequire(import.meta.url)` (from `node:module`), then `const manifestPath = require.resolve("typescript/package.json")`.
     - Read and `JSON.parse` that file. Take `bin.tsc`. If `bin` is a string, use it; if `bin.tsc` is missing or not a string, print an error naming `typescript/package.json` to stderr and exit 2.
     - `tscPath = path.resolve(path.dirname(manifestPath), binTsc)`.
     - If `typescript` cannot be resolved, print an error to stderr and exit 2 (no fallback to `npx` or a global `tsc`).
   - It runs the compiler as `process.execPath <tscPath> -p tsconfig.json` with `spawnSync` (no shell, `stdio: "inherit"`). A non-zero compiler status ends the script with that status, and no tests run.
   - It then runs `process.execPath --test <mapped...>` and exits with that status. A bad argument gives exit 2 before any work.
   - `.devflow/config.json` sets `"focused": "node scripts/test-focused.mjs {files}"`.
   - This is better than `npx tsc -p . && node --test {files}`: the role passes source paths that match `test.paths`, so the hook can check them, and the mapping to `dist/` happens in trusted script code instead of in the role.

## Impact zone

- src/config.ts
- src/focused.ts
- src/hook.ts
- src/runners.ts
- src/stages.ts
- src/prompts.ts
- scripts/test-focused.mjs
- .devflow/config.json
- test/config.test.ts
- test/focused.test.ts
- test/hook.test.ts
- test/runners.test.ts
- test/prompts.test.ts
- test/run.test.ts
- README.md
- docs/SPEC.md
- docs/DEVELOPMENT.md

## Test plan

- project-config / Valid focused template, Template without placeholder, Duplicate or unknown placeholder, Field absent → `test/config.test.ts`: parse a valid template; expect `invalid_config` with a `test.focused:` problem for a missing, duplicated or unknown placeholder; `initProject` output has no `focused`.
- project-config / Repository focused command → `test/focused.test.ts`:
  - Spawn `node scripts/test-focused.mjs README.md` and expect a non-zero exit and the argument named in stderr.
  - Assert that `.devflow/config.json` parses and `test.focused === "node scripts/test-focused.mjs {files}"`.
  - The positive path (compile + run one file) is exercised by the implementer's own focused runs and is not repeated inside the suite, to avoid recursive `tsc` in tests.
- runners / Focused command with test files allowed, Non-test path rejected, Extra command rejected, Empty file list rejected, Template text is not an allowlist entry, No focused entry keeps exact matching → `test/focused.test.ts` (unit tests of `matchFocused`, table-driven over tokens) and `test/hook.test.ts`:
  - `decide` allows `node scripts/test-focused.mjs test/hook.test.ts test/config.test.ts`.
  - `decide` denies `src/hook.ts`, `test/../src/hook.ts`, `/abs/test/x.test.ts`, `-r x`, `test/*.ts`, `test/a.ts;rm`, `... && rm -rf src`, `|`, newline, `$(x)`, quotes, backslash paths, 65 files, no files, and the raw template.
  - `runHook` with a scope file that contains `focused` returns allow/deny JSON.
  - Existing exact-match tests are unchanged.
- runners / Claude invocation with focused scope, Read-only run with focused scope rejected → `test/runners.test.ts`: `claudeInvocation` args contain `Bash(node scripts/test-focused.mjs:*)` and no `--disallowedTools`; `validateScope([], [], focused)` throws `invalid_scope`; the scope JSON written by the Claude path contains `focused` (the existing fake-CLI pattern).
- stage-execution / Implement with focused configured, Verify with focused configured, Working-copy focused ignored, Focused not configured → `test/run.test.ts`: with a fake runner that captures requests (the existing harness), commit a base config with or without `test.focused`, run implement and verify, and assert the `bash` and `focused` of the requests; modify only the working config and assert there is no `focused`.
- stage-execution / Implement prompt with and without focused command → `test/prompts.test.ts`: compose the `implement` and `small` templates and assert the required phrases (regression test first, fail for the expected reason, related tests pass with focused runs, do not run the full suite).
- stage-execution / Verify prompt with focused command, Severity rubric preserved, Verify prompt without focused command, Placeholder compatibility → `test/prompts.test.ts`:
  - Assert the snapshot hash re-check, the no-full-rerun rule and the evidence labels.
  - Assert that the existing severity and verdict-rule strings are present unchanged in rounds 1 and 2, with and without focused.
  - Assert that an override with the new placeholders composes, and that `{{focusedCommand}}` renders empty without focused.
