## MODIFIED Requirements

### Requirement: Stage contracts

Each model stage SHALL run with a fixed contract. explore: read-only except `.devflow/runs/<id>/facts.md`, which it must produce. design: writes only `openspec/changes/<id>/**` and must produce fresh `proposal.md`, `design.md`, `tasks.md` and every spec delta present. implement (and small): writes only the task zone plus the change's `tasks.md`, may run the test command and the configured `build.generate` command. verify: see Verify isolation.

#### Scenario: Design cannot touch source

- **WHEN** the design stage runs with a `claude` runner and tries to edit `src/a.ts`
- **THEN** the edit is refused by the write scope

#### Scenario: Missing facts

- **WHEN** explore exits 0 without writing `facts.md`
- **THEN** the stage is recorded as `explore fail`

#### Scenario: Stale spec delta

- **WHEN** a redesign rewrites the three Markdown files but leaves an old spec delta untouched
- **THEN** the design stage fails with reason `stale_delta`

#### Scenario: Implementer may regenerate

- **WHEN** `build.generate` is `npm run build:plugins` and the implement stage runs with a `claude` runner
- **THEN** the allowed shell commands are the test command and `npm run build:plugins`

## ADDED Requirements

### Requirement: Generate step after implement

When the trusted gate configuration defines `build.generate`, the implement (or small) stage SHALL run it in the project root after a successful model run that is neither blocked nor a plan conflict, and before recording the outcome. It MUST use the test command's shell runner: same environment, `test.timeout_seconds`, process-tree termination and task log. Only exit code 0 records `implement ok`.

#### Scenario: Generate runs after implement

- **WHEN** `build.generate` is configured and the implement model run succeeds
- **THEN** the command runs once in the project root after the model run, and `implement ok` is recorded only after it exits 0

#### Scenario: No generate after a failed run

- **WHEN** the implement model run fails, reports blocked, or reports a plan conflict
- **THEN** the generate command does not run

#### Scenario: Trusted command

- **WHEN** the working-tree config changes `build.generate` but the base commit's config has another value
- **THEN** the base commit's command runs

### Requirement: Generate failure feedback

A generate run that exits non-zero, times out or is killed SHALL record `implement fail` with reason `generate_failed` and write `.devflow/runs/<id>/generate-failure.md` with the command, the exit code or timeout, and the last 80 log lines. The next implement prompt SHALL include that file. The file MUST be removed once that prompt is composed, before the model starts, and when generate succeeds.

#### Scenario: Failure feeds back

- **WHEN** the generate command exits 1 after printing `bundle error`
- **THEN** the stage reports `fail` with `generate_failed`, the implement attempt count rises, and the next implement prompt contains `bundle error`

#### Scenario: Feedback consumed before the retry runs

- **WHEN** the implement attempt after a generate failure starts its model run
- **THEN** `generate-failure.md` no longer exists, and the saved prompt of that attempt contains `bundle error`

#### Scenario: Feedback is not repeated

- **WHEN** the attempt after a generate failure generates successfully
- **THEN** `generate-failure.md` does not exist and later prompts do not contain the old log tail

### Requirement: Generated outputs in the zone

The `build.outputs` globs of the trusted configuration SHALL count as part of a task's impact zone when the task has a zone, matched with every leading `./` segment ignored, as in the zone gate. The implement prompt SHALL list them as generated paths that the generate command rewrites. They MUST NOT give a zone to a task that has none.

#### Scenario: Prompt lists outputs

- **WHEN** the zone is `src/**` and `build.outputs` is `plugins/**`
- **THEN** the implement prompt's impact zone lists `src/**` and marks `plugins/**` as generated

### Requirement: Regeneration in the verify copy

When `build.generate` is configured, verify SHALL run it in the temporary worktree's project directory after the change set is applied and after `test.setup`, before the verifier starts. A failure SHALL record `verify human` with reason `verify_generate_failed`, without running the verifier. The worktree MUST still be removed.

#### Scenario: Verify copy is regenerated

- **WHEN** verify runs with `build.generate` configured
- **THEN** the command runs with the verify worktree's project directory as cwd before the verifier is launched

#### Scenario: Generate fails in the verify copy

- **WHEN** the generate command exits non-zero in the verify worktree
- **THEN** the task records `verify human` with `verify_generate_failed` and the worktree is removed
