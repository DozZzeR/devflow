# project-config Specification

## Purpose
Defines the per-project devflow configuration file (`.devflow/config.json`): which runner and model serve each role, attempt limits, the test command and artifact language, how it is validated, and how `devflow init` creates it.

## Requirements

### Requirement: Configuration file

The system SHALL read project configuration from `.devflow/config.json` at the project root (the nearest ancestor directory containing `.devflow/`). The configuration MUST define `roles` (each with `runner` in `claude | codex | command` and a `model` string; `command` roles also require a `command` template), `limits` (`implement`, `verify`, `escalate_after` as positive integers) and `test.command` with `test.paths`.

#### Scenario: Valid configuration loads

- **WHEN** `.devflow/config.json` matches the schema
- **THEN** commands that need configuration run normally

### Requirement: Artifact language

The configuration SHALL accept an optional `language` field (BCP 47 tag, for example `en` or `ru`) that sets the language of human-readable artifacts devflow writes and asks roles to write. When absent, the language SHALL be `en`.

#### Scenario: Default language

- **WHEN** the config has no `language` field
- **THEN** the loaded configuration reports language `en`

#### Scenario: Explicit language

- **WHEN** the config has `"language": "ru"`
- **THEN** the loaded configuration reports language `ru`

### Requirement: Strict validation

The system MUST reject a configuration with unknown fields, missing required fields or wrong types, reporting every problem with its JSON path, and MUST NOT fall back to defaults for an invalid file.

#### Scenario: Unknown field

- **WHEN** the config contains `"limitz": {}`
- **THEN** commands exit non-zero and the error names `limitz` as unknown

#### Scenario: Command runner without template

- **WHEN** a role has `"runner": "command"` and no `command`
- **THEN** commands exit non-zero naming `roles.<role>.command`

### Requirement: Role coverage

The configuration MUST provide a role for every stage that the tiers use (`explore`, `design`, `implement`, `verify`, `small`) and MAY provide `design_complex`. When `design_complex` is absent, complex tasks SHALL use `design`.

#### Scenario: Missing verify role

- **WHEN** `roles.verify` is absent
- **THEN** commands exit non-zero naming `roles.verify`

### Requirement: Initialization

`devflow init` SHALL create `.devflow/config.json` with documented defaults and `.devflow/.gitignore` containing `runs/` and `logs/`, and MUST NOT modify any other file, including the project's root `.gitignore`. If `.devflow/config.json` already exists, `init` MUST leave it unchanged and report that.

#### Scenario: Fresh init

- **WHEN** the user runs `devflow init` in a project without `.devflow/`
- **THEN** `.devflow/config.json` and `.devflow/.gitignore` exist and no other file changed

#### Scenario: Init is idempotent

- **WHEN** `.devflow/config.json` exists and the user runs `devflow init`
- **THEN** the file is unchanged and the command reports it already exists

### Requirement: Runner settings

The configuration SHALL accept an optional `runners` section with per-runner settings, strictly validated like the rest of the file: `runners.claude.use_api_key` (boolean, default false), `runners.codex.use_api_key` (boolean, default false), `runners.codex.ignore_user_config` (boolean, default false) and `runners.env.pass` (list of environment variable names, default empty).

#### Scenario: Runner settings accepted

- **WHEN** the config contains `"runners": { "codex": { "ignore_user_config": true } }`
- **THEN** it loads and the codex runner passes `--ignore-user-config`

#### Scenario: Unknown runner setting

- **WHEN** the config contains `"runners": { "codex": { "turbo": true } }`
- **THEN** commands exit non-zero naming `runners.codex.turbo` as unknown

### Requirement: Runner detection at init

When creating the config, `init` SHALL detect which of `claude` and `codex` are on PATH and choose role runners: both → mixed defaults (Claude roles, Codex verify); only `codex` → every role on Codex with `verify` on a different model than `implement`; only `claude` → likewise on Claude; neither → mixed defaults plus a warning. `--runners claude|codex|mixed` SHALL override detection.

#### Scenario: Codex-only machine

- **WHEN** only `codex` is on PATH and the user runs `devflow init`
- **THEN** every role in the new config uses runner `codex` and `roles.verify.model` differs from `roles.implement.model`

#### Scenario: No CLI found

- **WHEN** neither CLI is on PATH and the user runs `devflow init`
- **THEN** the config is created with mixed defaults and the output warns that no supported CLI was found

#### Scenario: Explicit override

- **WHEN** both CLIs are on PATH and the user runs `devflow init --runners claude`
- **THEN** every role uses runner `claude`

### Requirement: Ignore-file upgrade

If `.devflow/.gitignore` exists but lacks `runs/` or `logs/`, `init` SHALL append the missing lines and leave existing lines unchanged. If `.devflow` or that file is a symbolic link or junction, `init` MUST refuse with reason `unsafe_path` before writing anything.

#### Scenario: Old gitignore is upgraded

- **WHEN** `.devflow/.gitignore` contains only `runs/` and the user runs `devflow init`
- **THEN** the file contains `runs/` and `logs/`

### Requirement: Test run settings

The configuration SHALL accept optional `test.setup` (command run in the rollback worktree), `test.setup_inputs` (globs that trigger a second setup, default common dependency manifests and lockfiles), `test.red_exit_codes` (non-empty list of integers; default any non-zero code) and `test.timeout_seconds` (positive integer up to 86400, default 1800).

#### Scenario: Setup configured

- **WHEN** `test.setup` is `npm ci`
- **THEN** the rollback gate runs `npm ci` in the temporary worktree before the baseline run

#### Scenario: Invalid timeout

- **WHEN** `test.timeout_seconds` is 0
- **THEN** commands exit non-zero naming `test.timeout_seconds`

### Requirement: Build settings

The configuration SHALL accept an optional, strictly validated `build` section with `build.generate` (a non-empty command) and `build.outputs` (project-relative globs). An explicit `build.outputs`, even `[]`, MUST be rejected without `build.generate`. After stripping leading `./` segments, a glob MUST be rejected if it is empty, absolute, has a backslash or `..` segment, or starts with `.devflow`. A config without `build` SHALL behave as before.

#### Scenario: Build section accepted

- **WHEN** the config contains `"build": { "generate": "npm run build:plugins", "outputs": ["plugins/**"] }`
- **THEN** it loads and reports that command and those globs

#### Scenario: Leading ./ segments accepted

- **WHEN** `build.generate` is set and `build.outputs` is `["././plugins/**"]`
- **THEN** it loads and reports the glob as written

#### Scenario: No build section

- **WHEN** the config has no `build` field
- **THEN** it loads, and no generate step runs anywhere

#### Scenario: Unsafe output glob

- **WHEN** `build.outputs` contains `../x/**`, `.devflow/**`, `.devflow-cache/**`, `.devflow*/**` or `./.devflow/runs/**`
- **THEN** commands exit non-zero naming `build.outputs`

#### Scenario: Outputs without command

- **WHEN** `build.outputs` is `["plugins/**"]` and `build.generate` is absent
- **THEN** commands exit non-zero naming `build.generate`

#### Scenario: Empty outputs without command

- **WHEN** the config contains `"build": { "outputs": [] }`
- **THEN** commands exit non-zero naming `build.generate`

#### Scenario: Unknown build field

- **WHEN** the config contains `"build": { "watch": true }`
- **THEN** commands exit non-zero naming `build.watch` as unknown

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
