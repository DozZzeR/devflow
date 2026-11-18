## ADDED Requirements

### Requirement: Verification context

The verify prompt SHALL include a block "Threat model and verification context" from the first source with text: the top-level `context` value of `openspec/config.yaml`, then `.devflow/context.md`. A source path in the task's change set MUST be read from the task base, so a task cannot change the context its own verifier receives. With no text in any source the block SHALL be omitted. Other stages SHALL NOT receive it.

#### Scenario: Context from openspec config

- **WHEN** `openspec/config.yaml` committed at the base has `context: |` followed by indented text, and `.devflow/context.md` also exists
- **THEN** the verify prompt contains a "Threat model and verification context" block with the YAML text and without the `.devflow/context.md` text

#### Scenario: Folded context with a header comment

- **WHEN** `openspec/config.yaml` has `context: > # note` followed by two indented lines, a blank line and a third indented line
- **THEN** the block contains the first two lines joined by a space, a line break, and the third line, and does not contain `# note`

#### Scenario: Fallback to .devflow/context.md

- **WHEN** `openspec/config.yaml` has no `context` key, or only a commented-out one, and `.devflow/context.md` is committed at the base
- **THEN** the verify prompt contains the block with the text of `.devflow/context.md`

#### Scenario: No source

- **WHEN** neither source has text
- **THEN** the verify prompt has no "Threat model and verification context" block

#### Scenario: Task edits its own context

- **WHEN** the task's change set modifies `.devflow/context.md` that was committed at the base
- **THEN** the verify prompt contains the base text, not the modified text

#### Scenario: Only verify receives it

- **WHEN** a medium task with a committed `.devflow/context.md` runs explore, design and verify
- **THEN** only the verify prompt contains the context text

### Requirement: Severity rubric

The built-in verify prompt SHALL define finding severity: high — an acceptance criterion is not met, data loss, or a leak or escape within the stated threat model; medium — a likely defect with a workaround; low — style, tests or hardening outside the threat model. It SHALL instruct REWORK only when at least one high or medium finding exists, and PASS with low findings as notes otherwise. In later rounds the round rule further limits which findings may be raised.

#### Scenario: Rubric in first round

- **WHEN** the built-in verify prompt is composed for round 1
- **THEN** it contains the high, medium and low definitions and the rule that REWORK needs at least one high or medium finding

#### Scenario: Rubric with round narrowing

- **WHEN** the built-in verify prompt is composed for round 2
- **THEN** it contains the severity definitions and the instruction to report only high-severity findings and regressions, and the narrowing text appears once
