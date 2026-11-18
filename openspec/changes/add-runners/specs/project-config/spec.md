## MODIFIED Requirements

### Requirement: Initialization

`devflow init` SHALL create `.devflow/config.json` with documented defaults and `.devflow/.gitignore` containing `runs/` and `logs/`, and MUST NOT modify any other file, including the project's root `.gitignore`. If `.devflow/config.json` already exists, `init` MUST leave it unchanged and report that. When creating the config, `init` SHALL detect which of `claude` and `codex` are on PATH and choose role runners accordingly: both found → mixed defaults (Claude roles, Codex verify); only `codex` → every role on Codex, with `verify` on a different model than `implement`; only `claude` → every role on Claude, with `verify` on a different model than `implement`; neither → mixed defaults plus a warning. `--runners claude|codex|mixed` SHALL override detection.

#### Scenario: Fresh init

- **WHEN** the user runs `devflow init` in a project without `.devflow/`
- **THEN** `.devflow/config.json` and `.devflow/.gitignore` exist and no other file changed

#### Scenario: Init is idempotent

- **WHEN** `.devflow/config.json` exists and the user runs `devflow init`
- **THEN** the file is unchanged and the command reports it already exists

#### Scenario: Codex-only machine

- **WHEN** only `codex` is on PATH and the user runs `devflow init`
- **THEN** every role in the new config uses runner `codex` and `roles.verify.model` differs from `roles.implement.model`

#### Scenario: Explicit override

- **WHEN** both CLIs are on PATH and the user runs `devflow init --runners claude`
- **THEN** every role uses runner `claude`
