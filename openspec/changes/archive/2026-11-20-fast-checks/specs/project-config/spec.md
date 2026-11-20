## ADDED Requirements

### Requirement: Focused test command template

The config SHALL accept an optional string `test.focused` that contains the placeholder `{files}` exactly once and no other `{...}` placeholder. A template without `{files}`, with it twice, or with an unknown placeholder MUST fail validation with an `invalid_config` error that names `test.focused`. When the field is absent, the config MUST still parse, and init MUST NOT write the field.

#### Scenario: Valid focused template
- **WHEN** `.devflow/config.json` has `"test": { "command": "npm test", "paths": ["test/**"], "focused": "node scripts/test-focused.mjs {files}" }`
- **THEN** `parseConfig` returns a config whose `test.focused` equals that string

#### Scenario: Template without placeholder
- **WHEN** `test.focused` is `"node --test"`
- **THEN** `parseConfig` throws `invalid_config` with a problem line that starts with `test.focused:`

#### Scenario: Duplicate or unknown placeholder
- **WHEN** `test.focused` is `"run {files} {files}"` or `"run {files} {cwd}"`
- **THEN** `parseConfig` throws `invalid_config` for `test.focused`

#### Scenario: Field absent
- **WHEN** the config has no `test.focused` and init creates a default config
- **THEN** parsing succeeds with `test.focused` undefined, and the written default config has no `focused` key

### Requirement: Repository focused command

This repository's `.devflow/config.json` SHALL set `test.focused` to `node scripts/test-focused.mjs {files}`. `scripts/test-focused.mjs` MUST map each `<dir>/<name>.ts` argument to `dist/<dir>/<name>.js`, compile with the local TypeScript project, and then run `node --test` on only the mapped files. It MUST exit non-zero without running tests when an argument is not a `.ts` file inside the tsconfig `include` roots.

#### Scenario: Focused run of one test file
- **WHEN** `node scripts/test-focused.mjs test/hook.test.ts` runs in the repository
- **THEN** it compiles the project and runs `node --test dist/test/hook.test.js` only, and exits with that run's status

#### Scenario: Unsupported argument
- **WHEN** it is called with `README.md`
- **THEN** it exits non-zero with a message naming the argument and runs no tests
