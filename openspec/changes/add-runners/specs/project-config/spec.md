## MODIFIED Requirements

### Requirement: Initialization

`devflow init` SHALL create `.devflow/config.json` with documented defaults and `.devflow/.gitignore` containing `runs/` and `logs/`, and MUST NOT modify any other file, including the project's root `.gitignore`. If `.devflow/config.json` already exists, `init` MUST leave it unchanged and report that. If `.devflow/.gitignore` exists but lacks `runs/` or `logs/`, `init` SHALL append the missing lines and leave existing lines unchanged; if `.devflow` or that file is a symbolic link or junction, `init` MUST refuse with reason `unsafe_path`. When creating the config, `init` SHALL detect which of `claude` and `codex` are on PATH and choose role runners accordingly: both found → mixed defaults (Claude roles, Codex verify); only `codex` → every role on Codex, with `verify` on a different model than `implement`; only `claude` → every role on Claude, with `verify` on a different model than `implement`; neither → mixed defaults plus a warning that no supported CLI was found. `--runners claude|codex|mixed` SHALL override detection.

#### Scenario: Fresh init

- **WHEN** the user runs `devflow init` in a project without `.devflow/`
- **THEN** `.devflow/config.json` and `.devflow/.gitignore` exist and no other file changed

#### Scenario: Init is idempotent

- **WHEN** `.devflow/config.json` exists and the user runs `devflow init`
- **THEN** the file is unchanged and the command reports it already exists

#### Scenario: Old gitignore is upgraded

- **WHEN** `.devflow/.gitignore` contains only `runs/` and the user runs `devflow init`
- **THEN** the file contains `runs/` and `logs/`

#### Scenario: Codex-only machine

- **WHEN** only `codex` is on PATH and the user runs `devflow init`
- **THEN** every role in the new config uses runner `codex` and `roles.verify.model` differs from `roles.implement.model`

#### Scenario: No CLI found

- **WHEN** neither CLI is on PATH and the user runs `devflow init`
- **THEN** the config is created with mixed defaults and the output warns that no supported CLI was found

#### Scenario: Explicit override

- **WHEN** both CLIs are on PATH and the user runs `devflow init --runners claude`
- **THEN** every role uses runner `claude`

## ADDED Requirements

### Requirement: Runner settings

The configuration SHALL accept an optional `runners` section with per-runner settings, strictly validated like the rest of the file: `runners.claude.use_api_key` (boolean, default false), `runners.codex.use_api_key` (boolean, default false) and `runners.codex.ignore_user_config` (boolean, default true).

#### Scenario: Runner settings accepted

- **WHEN** the config contains `"runners": { "codex": { "ignore_user_config": false } }`
- **THEN** it loads and the codex runner does not pass `--ignore-user-config`

#### Scenario: Unknown runner setting

- **WHEN** the config contains `"runners": { "codex": { "turbo": true } }`
- **THEN** commands exit non-zero naming `runners.codex.turbo` as unknown
