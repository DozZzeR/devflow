# Design: verify-calibration

## Context

`runVerify` (`src/stages.ts:264-348`) builds the verifier context from the spec deltas, `tasks.md`, the test plan, the changed files and the gate results. It then runs the verifier in a detached worktree without `design.md` and without `.devflow/`. The verifier gets no project scope. The built-in template (`src/prompts.ts:80-93`) already says "REWORK only for at least one high or medium finding" but does not define the severities. `ROUND2_RULE` narrows round 2 and later to high-severity findings and regressions. `stages.ts:151-154` adds that narrowing again if the marker `ONLY high-severity` is missing from the prompt.

No code reads `openspec/config.yaml`. The project has no YAML dependency, and `docs/SPEC.md` asks for minimum dependencies. Apart from runs, logs and jobs, files under `.devflow/` count in the change set (`src/git.ts:46`). That affects the zone gate and the snapshot. Gates already trust `.devflow/config.json` only in the version committed at the task base (`src/gates.ts:43-59`).

## Decisions

1. **The context goes through `{{context}}`. There is no new placeholder.** `runVerify` puts a block `block("Threat model and verification context", text)` first in `ctx`. Project overrides that use `{{context}}` get it automatically, and `KNOWN` stays as it is. An override without `{{context}}` already loses all verify inputs, and it loses this one in the same way. devflow does not warn about this, as today.

2. **New module `src/verify-context.ts`.**
   - `verificationContext(root, base, changes): string` returns the trimmed text of the first source that has text, or `""`.
   - Source order: `openspec/config.yaml` key `context`, then `.devflow/context.md`.
   - It reads from the real project root, not from the verifier worktree, because the worktree has no `.devflow/`.

3. **Base read for changed sources.** If a source path is in the task's change set, its content is the version at the task base. devflow reads it with `git show <base>:<prefix><path>`, using `repoInfo(root).prefix` as `gateConfig` does. If the path does not exist at the base, the source counts as absent. If the path is not in the change set, the working-tree file is read; it equals the base version or is ignored by git.
   - Why: model roles and their outputs are in scope. An implementer whose zone includes the context file must not be able to change what its own verifier counts as in scope.
   - Consequence: this task's own verify gets no block, because `.devflow/context.md` is new in this change. That is intended.
   - This is a consistency rule, not a security boundary. Anyone who can commit is outside the threat model.

4. **A restricted YAML reader with no dependency.** `parseContextKey(yaml): string` reads only the top-level `context:` key. Where it accepts a form, the result must match what a YAML parser gives (after the final trim). It must never return text that YAML would read differently.
   - **Key.** The key must be at column 0. Lines that start with `#` are comments.
   - **Header comment.** After the key, a YAML comment is ignored: whitespace, then `#`, then anything up to the end of the line. This applies to block headers (`context: | # note`, `context: >- # note`) and to an empty value (`context: # note` is empty).
   - **Inline scalar `context: text`.**
     - Quoted value: one pair of matching outer `'` or `"` quotes is removed. A comment after the closing quote is ignored.
     - Plain (unquoted) value: a ` #` comment and the text after it are removed, then the value is trimmed.
   - **Block scalar header.** `context:`, then `|` or `>`, then an optional chomping indicator `-` or `+`, then an optional header comment. The body is the following lines that are blank or more indented than column 0. It ends at the first non-blank line at column 0. The common indentation of the non-blank body lines is removed.
   - **Literal `|`.** Line breaks are kept as they are.
   - **Folded `>`.** Folding follows YAML:
     - A line break between two consecutive non-blank lines at the common indentation becomes one space.
     - Blank lines are paragraph breaks. A run of k blank lines between two text lines gives k newlines, and the break before the run is dropped. For example, `a`, blank, `b` gives `a\nb`, and `a`, blank, blank, `b` gives `a\n\nb`.
     - Lines indented more than the common indentation are kept as they are, and so are the line breaks around them. They are not folded.
   - **Chomping.** The indicator is accepted but has no effect, because the result is trimmed in every case.
   - **Final trim.** The result is trimmed.
   - **Other forms.** A missing key, an empty value, a flow form, an anchor or alias, or an explicit indentation digit returns `""`, so the fallback source is used.
   - **Read errors.** A missing or unreadable file also counts as absent. A read error never fails verify.

5. **The rubric is added next to the verdict rule. The rule itself stays.** The verify template gets one new line just before the existing verdict rule:
   `Severity: high = an acceptance criterion is not met, data loss, or a leak or escape within the threat model stated in the context below; medium = a likely defect with a workaround; low = style, tests or hardening outside the threat model. Without a stated threat model, rate leaks and escapes against the acceptance criteria.`
   The sentence "Verdict rule: REWORK only for at least one high or medium finding; ..." does not change. That keeps the pinned test phrase and gives the task's REWORK rule.

6. **Round 2 does not change.** `ROUND2_RULE` still allows only high findings and regressions. The rubric sets how findings are rated. The round rule sets which findings may still be raised. The two do not conflict. In round 2, a medium finding from round 1 that is still not fixed is a regression and can still justify REWORK. The `ONLY high-severity` marker stays, so the fallback in `stages.ts:151-154` does not add the narrowing a second time.

7. **Enforcement stays in the prompt.** `verdictOf` still reads only the first line. Parsing findings to reject a REWORK that has only low findings is out of scope for this task.

8. **Repository context file.** `.devflow/context.md` (English):
   - devflow is a local, single-user tool.
   - Anyone who can write to the repository or to `.devflow/` is outside the threat model.
   - In scope: the model roles (explore, design, implement, verify, review), the environment they run in (write scope, worktree, environment variables, processes), and their outputs (files, verdicts, logs) as devflow consumes them.
   - Findings about attackers outside this scope are low.
   `openspec/config.yaml` is not changed, so `.devflow/context.md` is the single source for this repository.

## Impact zone

- src/verify-context.ts
- src/stages.ts
- src/prompts.ts
- test/verify-context.test.ts
- test/prompts.test.ts
- test/run.test.ts
- .devflow/context.md
- plugins/**

`plugins/**` is in the zone because the plugin bundles (`plugins/claude/devflow/bin/devflow.mjs`, `plugins/codex/devflow/bin/devflow.mjs`) are built from `src` with `npm run build:plugins`. `test/plugins.test.ts` fails when they are stale.

## Test plan

- **Verification context / Context from openspec config**: `test/verify-context.test.ts`. A git project commits `openspec/config.yaml` with `context: |` and indented text, plus `.devflow/context.md` with other text. The test checks that `verificationContext` returns the YAML text only.
  Unit cases for `parseContextKey` with the expected results:
  - `|` keeps line breaks: `"context: |\n  a\n  b\n"` gives `"a\nb"`.
  - `|-` behaves the same as `|`.
  - `>` folds. The existing case changes to `"context: >\n  folded text\n  more\n"` and gives `"folded text more"`.
  - Regression for folding: a blank line is a paragraph break. `"context: >\n  a\n  b\n\n  c\n  d\n"` gives `"a b\nc d"`, and two blank lines between `b` and `c` give `"a b\n\nc d"`.
  - Regression for folding: a more-indented line is not folded. `"context: >\n  a\n    code\n  b\n"` gives `"a\n  code\nb"`.
  - Regression for header comments: `"context: | # note\n  x\n  y\n"` gives `"x\ny"`, and `"context: >- # note\n  x\n  y\n"` gives `"x y"`.
  - Inline values: a plain inline value, a plain inline value with ` # note` (the comment is removed), and a quoted inline value with a trailing comment.
  - These return `""`: a commented `# context: |`, an empty `context:`, `context: # note`, and a missing key.
- **Verification context / Folded context with a header comment**: `test/verify-context.test.ts`. The `parseContextKey` regressions for folding and header comments listed above. A `verificationContext` case commits `openspec/config.yaml` with `context: > # note\n  a\n  b\n\n  c\n` and checks that the result is `"a b\nc"`.
- **Verification context / Fallback to .devflow/context.md**: `test/verify-context.test.ts`. The `config.yaml` has only the commented example, and a committed `.devflow/context.md` gives its text.
- **Verification context / No source**: `test/verify-context.test.ts` checks that the function returns `""`. `test/run.test.ts` checks that the default end-to-end VERIFY prompt has no `Threat model and verification context`.
- **Verification context / Task edits its own context**: `test/verify-context.test.ts`. The test commits `.devflow/context.md` as "BASE-SCOPE", then changes it in the working tree to "CHANGED-SCOPE". With `changes` including the path, the function returns "BASE-SCOPE". A second case uses a new, uncommitted file that is in `changes` and checks that it returns `""`.
- **Verification context / Only verify receives it**: `test/run.test.ts`, new test. It commits `.devflow/context.md` with `THREAT-MODEL-MARKER` before `devflow start`, then runs the medium flow to DONE. The saved VERIFY prompt contains the marker under `## Threat model and verification context`. The saved EXPLORE and DESIGN prompts do not contain it.
- **Severity rubric / Rubric in first round**: `test/prompts.test.ts`. The round-1 built-in verify prompt contains `high = an acceptance criterion is not met`, `medium = a likely defect with a workaround`, `low = style, tests or hardening outside the threat model` and `REWORK only for at least one high or medium finding`.
- **Severity rubric / Rubric with round narrowing**: `test/prompts.test.ts`. The round-2 prompt contains the three definitions, and `ONLY high-severity findings and regressions` appears exactly once.
- Regression: all existing tests in `test/prompts.test.ts`, `test/run.test.ts` and `test/lifecycle.test.ts` pass unchanged.
- Bundles: `test/plugins.test.ts` ("committed plugins equal a fresh build") passes after `npm run build:plugins`.
