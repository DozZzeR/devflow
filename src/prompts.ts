/** @file Assemble stage-specific prompts from project overrides, role inputs and verification history. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEVFLOW_DIR } from "./config.js";
import { DevflowError } from "./errors.js";

/** Prompt template key, including the small-task variant of implementation. */
export type PromptStage = "explore" | "design" | "implement" | "small" | "verify";

/** Placeholders a template may use. Unknown placeholders are an error, missing values become empty. */
export interface PromptInputs {
  /** Task identifier interpolated into the role instructions. */
  id: string;
  /** User's task description supplied to the role. */
  description: string;
  /** Optional external issue reference shown with the task. */
  tracker?: string;
  /** Language requested for human-readable artifacts. */
  language: string;
  /** Paths the role should write, in words. */
  outputs: string;
  /** Inlined context blocks prepared by the stage. */
  context: string;
  /** Project test command provided to the role. */
  testCommand: string;
  /** Focused test command template with a `{files}` placeholder, when the project configures one. */
  focusedCommand?: string;
  /** Verification round controlling whether previous findings are in scope. */
  round?: number;
  /** Review evidence inserted for a subsequent verification round. */
  previousVerdict?: string;
}

/** Shared role, task, language and output-scope instructions. */
const COMMON_HEADER = `You are the {{role}} role in a devflow task. Other roles plan, implement and verify; you do only your part.
Task id: {{id}}{{tracker}}
Task: {{description}}
Write every human-readable artifact in language: {{language}}. Keep code, paths, commands and identifiers as they are.
Only write the files named under "Outputs". Writes elsewhere are blocked or discarded.

`;

/** Built-in descriptions of the artifacts and decisions expected from each role. */
export const TEMPLATES: Record<PromptStage, string> = {
  explore:
    COMMON_HEADER.replace("{{role}}", "EXPLORE") +
    `Goal: collect the facts the designer needs. Read the code and the living specs; do not design or change anything. Ignore the .devflow/ folder (tool state, not project code).

Write a short Markdown file with sections:
## Relevant code — files, functions, data that the task touches (with paths)
## Existing behaviour — what happens today
## Constraints and risks — conventions, fragile areas, missing tests
## Open questions — only those a designer cannot answer from the code

{{context}}

Outputs: {{outputs}}
`,
  design:
    COMMON_HEADER.replace("{{role}}", "DESIGN") +
    `Goal: write the plan as an OpenSpec change (spec-driven format) in openspec/changes/{{id}}/. Do not change source code.

Required files:
- proposal.md: "## Why", "## What Changes", "## Capabilities" (New / Modified), "## Impact".
- specs/<capability>/spec.md for each capability: "## ADDED|MODIFIED|REMOVED Requirements", each "### Requirement: <name>" with SHALL/MUST text (under 500 characters) and at least one "#### Scenario:" with **WHEN** / **THEN** lines. New capabilities start with "## Purpose".
- design.md: "## Context", "## Decisions", "## Impact zone" (a list, one glob per line, of every file the implementer may change, including tests), "## Test plan" (which tests prove each scenario).
- tasks.md: decompose the plan into independently verifiable nodes. Preserve existing node IDs across revisions. Each node names its acceptance scenario, dependencies where needed, and how to verify it. Use numbered groups with "- [ ] X.Y" checkbox tasks, each saying how it is verified.
When revising a numbered REWORK after a scope decision, put one row per finding under "## Review decisions (round N)" in tasks.md. Use "- F1 | fix | 1.1 | concrete instruction" or "- F2 | defer | - | reason" or "- F3 | dismiss | - | reason". Derive N from the review context. Honor human scope decisions.
Rewrite every spec delta you keep; delete deltas that no longer apply.

{{context}}

Outputs: {{outputs}}
`,
  implement:
    COMMON_HEADER.replace("{{role}}", "IMPLEMENT") +
    `Goal: implement the approved plan. Follow tasks.md in order, write tests first where the test plan names them, and tick each finished task in tasks.md ("- [x]").
Stay inside the impact zone. {{implementTests}}
Do not edit proposal.md, design.md or spec deltas. Use a stable [node-id/issue-slug] at the start of a conflict reason only when revising that checkbox is sufficient; shared contracts require a full plan revision. Reuse the key when the same issue recurs. If the plan itself is wrong, or a finding below cannot be fixed without changing the plan, change nothing and make your final line the words PLAN CONFLICT, a colon, and what the plan must change; devflow then sends the plan back to design.
If you cannot work at all for a reason outside the plan (a file or tool you need is not accessible), change nothing and make your final line the word BLOCKED, a colon, and what is missing. Instructions outside the project that you cannot read are not a reason to stop: continue without them and mention it.

{{context}}

Outputs: {{outputs}}
`,
  small:
    COMMON_HEADER.replace("{{role}}", "IMPLEMENT (small task)") +
    `Goal: make the small change described above, with a test that fails without it and passes with it.
{{implementTests}}

{{context}}

Outputs: {{outputs}}
`,
  verify:
    COMMON_HEADER.replace("{{role}}", "VERIFY") +
    `Goal: independently check the implemented change against its acceptance criteria. You did not plan or write it, and you are working in a disposable copy of the project: edits you make are discarded.
Acceptance criteria are the requirements and scenarios in the spec deltas below. You may read the changed files.
{{verifyTests}}
For every requirement decide MET, PARTIAL or NOT MET with file:line evidence. Look for tests that would still pass if the code were wrong.
design.md and the .devflow/ folder are intentionally absent from this copy (you judge the result, not the author's reasoning); do not report their absence or their deletion in git status.
Severity: high = an acceptance criterion is not met, data loss, or a leak or escape within the threat model stated in the context below; medium = a likely defect with a workaround; low = style, tests or hardening outside the threat model. Without a stated threat model, rate leaks and escapes against the acceptance criteria.
Verdict rule: REWORK only for at least one high or medium finding; HUMAN when you cannot judge; otherwise PASS, listing low findings as notes.
{{roundRule}}
Write the verdict file in English, first line exactly one of: "VERDICT: PASS", "VERDICT: REWORK", "VERDICT: HUMAN". Then a table requirement | status | evidence, where each evidence cell starts with "confirmed by gates" or "checked additionally", then a separate Markdown section headed exactly "## Findings". Put one unindented numbered item per finding (severity high/medium/low, file:line, concrete fix); indent continuation lines. Put test execution notes under a separate heading. REWORK needs at least one concrete fix. No praise.

{{context}}
{{previousVerdict}}
Outputs: {{outputs}}
`,
};

/** Limit later verify rounds to high-severity issues and regressions of prior findings. */
const ROUND2_RULE = `This is round {{round}}. Report ONLY high-severity findings and regressions of findings from the previous verdict below. Do not raise new medium or low findings.`;

/** Evidence label for results the gates produced for the exact snapshot. */
export const EVIDENCE_GATES = "confirmed by gates";
/** Evidence label for results the verifier checked itself. */
export const EVIDENCE_EXTRA = "checked additionally";

/** Placeholder names accepted by project prompt overrides. */
const KNOWN = new Set([
  "role", "id", "tracker", "description", "language", "outputs", "context", "testCommand", "focusedCommand",
  "implementTests", "verifyTests", "roundRule", "previousVerdict", "round",
]);

/** Testing rules for implement and small prompts; focused runs replace full-suite runs when configured. */
function implementTests(testCommand: string, focused: string | undefined): string {
  const first = "Testing: write the new regression test first.";
  if (!focused) {
    return `${first} Run it with the test command \`${testCommand}\` and see it fail for the expected reason on the old code. Then make it and the related tests pass.`;
  }
  return `${first} Run only it with the focused command \`${focused}\` (replace {files} with the test file paths, space-separated) and see it fail for the expected reason on the old code. Then make it and the related tests pass with focused runs. Do not run the full suite \`${testCommand}\`; the gates run it.`;
}

/** Testing rules for the verify prompt: gate evidence first, extra runs only for open questions. */
function verifyTests(testCommand: string, focused: string | undefined): string {
  const lead = "The gate results below are for the exact snapshot you check; devflow re-checks the snapshot hash before it accepts PASS.";
  const labels = `In the verdict, mark each piece of evidence as '${EVIDENCE_GATES}' or '${EVIDENCE_EXTRA}'.`;
  return focused
    ? `${lead} Do not rerun the full suite \`${testCommand}\`. Run \`${focused}\` only for a concrete question the gates did not answer. ${labels}`
    : `${lead} Do not rerun the full suite as a routine check. Run \`${testCommand}\` only for a concrete question the gates did not answer. ${labels}`;
}

/** Load a project stage override if present, otherwise return its built-in prompt. */
export function loadTemplate(root: string, stage: PromptStage): string {
  const override = join(root, DEVFLOW_DIR, "prompts", `${stage}.md`);
  if (existsSync(override)) return readFileSync(override, "utf8");
  return TEMPLATES[stage];
}

/** Render a template from stage inputs and reject unrecognized placeholders. */
export function composePrompt(template: string, inputs: PromptInputs): string {
  const round = inputs.round ?? 1;
  const values: Record<string, string> = {
    role: "",
    id: inputs.id,
    tracker: inputs.tracker ? ` (tracker: ${inputs.tracker})` : "",
    description: inputs.description,
    language: inputs.language,
    outputs: inputs.outputs,
    context: inputs.context,
    testCommand: inputs.testCommand,
    focusedCommand: inputs.focusedCommand ?? "",
    implementTests: implementTests(inputs.testCommand, inputs.focusedCommand),
    verifyTests: verifyTests(inputs.testCommand, inputs.focusedCommand),
    round: String(round),
    roundRule: round >= 2 ? ROUND2_RULE.replace("{{round}}", String(round)) : "",
    previousVerdict: round >= 2 && inputs.previousVerdict ? `## Previous verdict\n\n${inputs.previousVerdict}\n` : "",
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!KNOWN.has(key)) throw new DevflowError("invalid_template", `Unknown placeholder {{${key}}} in a stage prompt.`);
    return values[key] ?? "";
  });
}

/** A titled block of inlined text, or nothing when the text is empty. */
export function block(title: string, text: string | undefined): string {
  return text && text.trim() ? `## ${title}\n\n${text.trim()}\n\n` : "";
}

/** Extract one "## Heading" section (without the heading line) from Markdown. */
export function section(markdown: string, heading: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && /^#{1,2}\s/.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
}
