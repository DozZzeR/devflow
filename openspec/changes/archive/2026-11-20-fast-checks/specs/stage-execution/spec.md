## ADDED Requirements

### Requirement: Focused test scope for implement and verify roles

When the trusted config (the one `gateConfig` returns) has `test.focused`, implement, small and verify SHALL pass `focused: { template: test.focused, paths: test.paths }` to the runner. In that case implement/small MUST NOT get `test.command` in `bash`, and verify MUST get an empty `bash`. Without `test.focused`, the shell scopes MUST stay as today. Gates MUST keep using `test.command`.

#### Scenario: Implement with focused configured
- **WHEN** the trusted config has `test.focused` and the implement stage runs
- **THEN** the runner request has `focused` with that template and `test.paths`, and `bash` holds only `build.generate` when one is set

#### Scenario: Verify with focused configured
- **WHEN** the trusted config has `test.focused` and verify runs
- **THEN** the runner request has the `focused` entry and `bash: []`

#### Scenario: Working-copy focused ignored
- **WHEN** the working `.devflow/config.json` sets a `test.focused` that the base commit does not have
- **THEN** the role request has no `focused` entry

#### Scenario: Focused not configured
- **WHEN** no `test.focused` is configured
- **THEN** implement/small get `bash` with `test.command` and verify gets `bash: [test.command]`, as before

### Requirement: Focused test rules in implement and small prompts

The built-in implement and small prompts SHALL render `{{implementTests}}`. When a focused command exists, it MUST tell the role to write the new regression test first, run it with the focused command and see it fail for the expected reason on the old code, then make it and the related tests pass with focused runs, and not to run the full suite because the gates do.

#### Scenario: Implement prompt with focused command
- **WHEN** the implement or small prompt is composed with `focusedCommand: "node scripts/test-focused.mjs {files}"`
- **THEN** the text contains that command, says to write the regression test first, says to see it fail for the expected reason before changing code, says to make it and related tests pass with focused runs, and says not to run the full suite `{{testCommand}}`

#### Scenario: Implement prompt without focused command
- **WHEN** the prompt is composed without `focusedCommand`
- **THEN** it still says to write the regression test first and see it fail, and it allows the full test command

### Requirement: Gate-based evidence in the verify prompt

The built-in verify prompt SHALL render `{{verifyTests}}`. It MUST say that the gate results are for the exact snapshot under review, that devflow re-checks the snapshot hash before it accepts PASS, that the role must not rerun the full suite, and that focused tests are only for a concrete question the gates did not answer. The verdict MUST keep "confirmed by gates" apart from "checked additionally". The severity rubric and the verdict rule MUST NOT change.

#### Scenario: Verify prompt with focused command
- **WHEN** the verify prompt is composed with a focused command
- **THEN** it names the focused command, forbids rerunning the full suite, states the snapshot hash re-check, and requires the evidence labels "confirmed by gates" and "checked additionally"

#### Scenario: Severity rubric preserved
- **WHEN** the verify prompt is composed in round 1 or round 2, with or without a focused command
- **THEN** the severity and verdict-rule sentences are byte-identical to the current ones, and round 2 still includes the ONLY high-severity rule

#### Scenario: Verify prompt without focused command
- **WHEN** no focused command is configured
- **THEN** the prompt still forbids rerunning the full suite as a routine check, allows `{{testCommand}}` only for a concrete question the gates did not answer, and requires the two evidence labels

#### Scenario: Placeholder compatibility
- **WHEN** a project prompt override uses `{{testCommand}}`, `{{focusedCommand}}`, `{{implementTests}}` or `{{verifyTests}}`
- **THEN** composition succeeds, and `{{focusedCommand}}` renders empty when no focused command is configured
