## ADDED Requirements

### Requirement: Test run settings

The configuration SHALL accept optional `test.setup` (command run in the rollback worktree), `test.setup_inputs` (globs that trigger a second setup, default common dependency manifests and lockfiles), `test.red_exit_codes` (non-empty list of integers; default any non-zero code) and `test.timeout_seconds` (positive integer up to 86400, default 1800).

#### Scenario: Setup configured

- **WHEN** `test.setup` is `npm ci`
- **THEN** the rollback gate runs `npm ci` in the temporary worktree before the baseline run

#### Scenario: Invalid timeout

- **WHEN** `test.timeout_seconds` is 0
- **THEN** commands exit non-zero naming `test.timeout_seconds`
