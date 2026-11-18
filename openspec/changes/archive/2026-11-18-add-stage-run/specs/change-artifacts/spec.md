## Purpose

Defines where and in which format a task's plan lives (an OpenSpec change folder with devflow's own sections inside its design), how it is validated, and which parts of it each stage may read, so that the plan has one source of truth and is native to OpenSpec whether or not OpenSpec is installed.

## ADDED Requirements

### Requirement: Change folder location and format

The plan of a medium or complex task SHALL live in `openspec/changes/<task-id>/` with `proposal.md`, `design.md`, `tasks.md` and spec deltas under `specs/<capability>/spec.md`, in the OpenSpec `spec-driven` format, whether or not OpenSpec is installed in the project. devflow MUST NOT write OpenSpec configuration or schemas.

#### Scenario: Project without OpenSpec

- **WHEN** a project has no `openspec/` directory and a medium task reaches design
- **THEN** `openspec/changes/<task-id>/` is created in the same format and no `openspec/config.yaml` is written

### Requirement: devflow sections in design

`design.md` SHALL contain `## Impact zone` (one glob per list item) and `## Test plan`. These are devflow's only additions to the change format; machine state stays in `.devflow/runs/<id>/`.

#### Scenario: Zone source

- **WHEN** design.md lists `- src/**` under `## Impact zone`
- **THEN** after design the task zone is `src/**`

### Requirement: Validation

When the OpenSpec CLI is available (`openspec.cli` is `auto` and the command resolves, or `on`), the system SHALL validate the change with `openspec validate <task-id> --strict`; when it is `off` or unavailable in `auto`, the system SHALL check only that the required files and sections exist. `on` with no CLI MUST fail the design stage with `openspec_missing`.

#### Scenario: CLI unavailable

- **WHEN** `openspec.cli` is `auto` and no `openspec` command resolves
- **THEN** design is checked for required files and sections only

### Requirement: Stage visibility

Each stage SHALL receive only these artifacts: explore — the task description and `openspec/specs/` if present; design — the task, `facts.md` and `openspec/specs/`; implement — the change folder; verify — as defined in stage execution (spec deltas, tasks, test plan, change set, gate results).

#### Scenario: Implement sees the plan, not exploration notes

- **WHEN** implement runs
- **THEN** its prompt includes the change folder contents and not `facts.md`
