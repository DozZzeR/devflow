# Proposal: verify-calibration

## Why

Verify does not converge. The verifier has no threat model, so it reports hardening ideas against attackers the project does not defend against (for example someone who can already write to the repository or to `.devflow/`). It also has no definition of high, medium and low, so the same kind of finding is rated differently from round to round, and a REWORK can rest on findings that do not matter. `docs/TODO.md` records REWORK verdicts on low-only findings and extra findings in round 2. The verifier needs a stated scope and a fixed severity scale.

## What Changes

- The verify prompt receives a new context block, "Threat model and verification context". Its text comes from the first source that has text:
  1. the top-level `context` value in `openspec/config.yaml`. It is read with a small built-in reader and needs no new dependency. For the forms the reader accepts, the result is the same as YAML gives: `>` is folded, `|` keeps line breaks, and header comments are ignored. An empty or commented-out key counts as absent;
  2. `.devflow/context.md`.
  If the task's own change set contains a source file, devflow reads that file from the task base instead. A task therefore cannot change the scope its own verifier judges against. If no source has text, the block is left out. Other stages do not get the block.
- The built-in verify template gets a severity rubric:
  - high = an acceptance criterion is not met, data loss, or a leak or escape within the stated threat model;
  - medium = a likely defect with a workaround;
  - low = style, tests or hardening outside the threat model.
  The existing verdict rule stays: REWORK only when there is at least one high or medium finding; otherwise PASS, with low findings listed as notes. The round-2 narrowing does not change.
- This repository gets `.devflow/context.md`. It says that devflow is a local single-user tool, that anyone who can write to the repository or to `.devflow/` is outside the threat model, and that model roles, their environment and their outputs are in scope.
- Tests for the context reader, the prompt block and the rubric.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `stage-execution`: two new requirements, "Verification context" and "Severity rubric".

## Impact

- Code: `src/prompts.ts` (rubric text in the verify template), `src/stages.ts` (`runVerify` adds the block), new `src/verify-context.ts` (reads the source and parses the YAML subset).
- Plugin bundles `plugins/claude/devflow/bin/devflow.mjs` and `plugins/codex/devflow/bin/devflow.mjs` are rebuilt from `src` with `npm run build:plugins`.
- Data: new tracked file `.devflow/context.md`. It is part of this task's change set, so it is inside the impact zone. Because of the base-read rule, this task's own verifier does not see it; later tasks do once it is committed.
- No new dependency. No change to the verdict file format, to `verdictOf`, to the round-2 rule or to the run state.
- Project overrides `.devflow/prompts/verify.md` get the block through `{{context}}`, the same way as every other verify input. They do not get the rubric, because they replace the built-in template.
