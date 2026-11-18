# role-management Specification

## Purpose
Defines how the role → runner/model layout of a project is shown, proposed from what is actually available, and changed, including the rule that the most demanding roles get the strongest available model.

## Requirements

### Requirement: Show roles

`devflow roles [--json]` SHALL list every configured role with runner and model.

#### Scenario: Table

- **WHEN** the user runs `devflow roles`
- **THEN** each role is printed with its runner and model

### Requirement: Model ranking

The system SHALL keep one cross-vendor ranking of known models (strongest first: claude/fable, claude/opus, codex/gpt-6.2-sol, claude/sonnet, codex/gpt-5.6-terra, claude/haiku, codex/gpt-5.6-luna). Candidates are the ranked models whose CLI is installed and, when probing, that answer a minimal call through the project's runner settings.

#### Scenario: Codex only

- **WHEN** only `codex` is installed
- **THEN** candidates are the codex models in ranking order

### Requirement: Propose a layout

`devflow roles propose [--probe] [--apply]` SHALL assign: `design_complex` and `review` the strongest candidate; `design` the strongest candidate that is not Fable; `implement` and `small` the third-strongest or nearest; `explore` the weakest; `verify` the strongest candidate different from `implement`, preferring the other vendor. With one candidate every role uses it and the result warns `verify_not_independent`; with none it fails with `no_models`. Without `--apply` nothing is written.

#### Scenario: Fable unavailable

- **WHEN** `--probe` finds that `claude/fable` fails and `claude/opus` answers
- **THEN** the proposal puts `design_complex` and `review` on `claude/opus`

#### Scenario: Preview only

- **WHEN** the user runs `devflow roles propose` without `--apply`
- **THEN** `.devflow/config.json` is unchanged

### Requirement: Unprobed defaults

`devflow init` SHALL not use Fable: with Claude available, `design_complex` and `review` default to `claude/opus`; with Codex only, to `codex/gpt-6.2-sol`.

#### Scenario: Fresh init

- **WHEN** both CLIs are installed and the user runs `devflow init`
- **THEN** `roles.design_complex` is `claude/opus`

### Requirement: Set a role

`devflow roles set <role> <runner> <model> [--command "<template>"]` SHALL change one role in `.devflow/config.json` (the template is required for `command` runners), keep the rest of the file, validate the result and write atomically; an invalid result leaves the file unchanged.

#### Scenario: Unknown runner

- **WHEN** the user runs `devflow roles set verify gemini x`
- **THEN** the command fails with `invalid_config` and the file is unchanged
