## Purpose

Defines how the role → runner/model layout of a project is shown, proposed from what is actually available, and changed, including the rule that the most demanding roles get the strongest available model.

## ADDED Requirements

### Requirement: Show roles

`devflow roles [--json]` SHALL list every configured role with runner and model.

#### Scenario: Table

- **WHEN** the user runs `devflow roles`
- **THEN** each role is printed with its runner and model

### Requirement: Propose a layout

`devflow roles propose [--probe]` SHALL suggest a full role layout from the installed CLIs and a ranked list of known models per runner. With `--probe` it SHALL keep only models that answer a minimal call. `design_complex` and `review` SHALL get the strongest remaining model; `verify` SHALL use a different model from `implement`. The proposal is printed and not written unless `--apply` is given.

#### Scenario: Fable unavailable

- **WHEN** `--probe` finds that `claude/fable` fails and `claude/opus` answers
- **THEN** the proposal puts `design_complex` and `review` on `claude/opus`

#### Scenario: Preview only

- **WHEN** the user runs `devflow roles propose` without `--apply`
- **THEN** `.devflow/config.json` is unchanged

### Requirement: Set a role

`devflow roles set <role> <runner> <model>` SHALL change one role in `.devflow/config.json`, keeping the rest of the file and validating the result.

#### Scenario: Unknown runner

- **WHEN** the user runs `devflow roles set verify gemini x`
- **THEN** the command fails with `invalid_config` and the file is unchanged
