# Tasks: verify-calibration

## 1. Tests first

- [x] 1.1 In `test/verify-context.test.ts`, update and extend the `parseContextKey` cases as listed in the design test plan:
  - change the existing `>` case to expect `"folded text more"`;
  - add the folding regressions: a blank line is a paragraph break, two blank lines give two newlines, and a more-indented line is kept;
  - add the header-comment regressions `context: | # note` and `context: >- # note`;
  - add a plain inline value with ` # note`, a quoted inline value with a trailing comment, and `context: # note` (gives `""`);
  - keep the existing `|`, `|-`, inline, quoted, commented, empty and missing-key cases;
  - add a `verificationContext` case on a git project: a committed `openspec/config.yaml` with `context: > # note\n  a\n  b\n\n  c\n` gives `"a b\nc"`.
  Verified by: the new and changed cases fail against the current `src/verify-context.ts`.
- [x] 1.2 In `test/verify-context.test.ts`, add `verificationContext` cases on a git project (`test/gitrepo.ts`):
  - YAML wins over `.devflow/context.md`;
  - fallback to `.devflow/context.md`;
  - no source returns `""`;
  - a changed source returns its base text;
  - a new source that is in the change set returns `""`.
  Verified by: the tests fail before 2.1.
- [x] 1.3 In `test/prompts.test.ts`, assert the three severity definitions in round 1 and round 2, and that `ONLY high-severity findings and regressions` appears exactly once in round 2. Verified by: the tests fail before 3.1.
- [x] 1.4 In `test/run.test.ts`, add a medium-flow test that commits `.devflow/context.md` with `THREAT-MODEL-MARKER`. Assert that the marker is in the saved VERIFY prompt under `## Threat model and verification context` and is not in the saved EXPLORE or DESIGN prompts. In the existing medium test, assert that the VERIFY prompt has no such block. Verified by: the new test fails before 2.2.

## 2. Verification context

- [x] 2.1 Change `parseContextKey` in `src/verify-context.ts` to follow design decision 4:
  - ignore a YAML comment after the key on the header line, for block headers, empty values and inline values;
  - fold `>` bodies like YAML: consecutive lines join with a space, blank lines become paragraph breaks, and more-indented lines are kept as they are;
  - return `""` for an explicit indentation digit.
  Do not change `verificationContext` or add a dependency. Verified by: all cases from 1.1 and 1.2 pass.
- [x] 2.2 In `runVerify` (`src/stages.ts`), compute the change set once and put `block("Threat model and verification context", verificationContext(root, task.base, changes))` first in `ctx`. Verified by: the test from 1.4 passes and the existing `test/run.test.ts` tests still pass.
- [x] 2.3 Rebuild the plugin bundles with `npm run build:plugins`, so that `plugins/claude/devflow/bin/devflow.mjs` and `plugins/codex/devflow/bin/devflow.mjs` contain the final `src`. Verified by: `test/plugins.test.ts` "committed plugins equal a fresh build" passes.

## 3. Severity rubric

- [x] 3.1 In the verify template in `src/prompts.ts`, add the severity line from design decision 5 just before the existing verdict rule. Do not change the verdict rule, `ROUND2_RULE` or `KNOWN`. Verified by: the tests from 1.3 pass, and the existing assertions in `test/prompts.test.ts` still pass.

## 4. Repository context

- [x] 4.1 Write `.devflow/context.md` in English with the content from design decision 8. Verified by: review of the file, and the zone gate passes because the path is in the impact zone.

## 5. Full check

- [ ] 5.1 Run the project test command (`npm test`). Verified by: all tests pass, including `test/lifecycle.test.ts` and `test/plugins.test.ts`. Unrelated tests are not changed.
