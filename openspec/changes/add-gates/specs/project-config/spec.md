## ADDED Requirements

### Requirement: Test setup command

The configuration SHALL accept an optional `test.setup` command, run in the rollback gate's temporary worktree before the baseline test run (for example dependency installation), and an optional `test.timeout_seconds` (positive integer, default 1800) applied to each test run.

#### Scenario: Setup configured

- **WHEN** `test.setup` is `npm ci`
- **THEN** the rollback gate runs `npm ci` in the temporary worktree before the baseline run

#### Scenario: Invalid timeout

- **WHEN** `test.timeout_seconds` is 0
- **THEN** commands exit non-zero naming `test.timeout_seconds`
