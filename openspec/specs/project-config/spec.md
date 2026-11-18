# project-config Specification

## Purpose
TBD - created by archiving change add-core-state-machine. Update Purpose after archive.

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

`devflow init` SHALL create `.devflow/config.json` with documented defaults and `.devflow/.gitignore` containing `runs/`, and MUST NOT modify any other file, including the project's root `.gitignore`. If `.devflow/config.json` already exists, `init` MUST leave it unchanged and report that.

#### Scenario: Fresh init

- **WHEN** the user runs `devflow init` in a project without `.devflow/`
- **THEN** `.devflow/config.json` and `.devflow/.gitignore` exist and no other file changed

#### Scenario: Init is idempotent

- **WHEN** `.devflow/config.json` exists and the user runs `devflow init`
- **THEN** the file is unchanged and the command reports it already exists
