import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEVFLOW_DIR } from "./config.js";
import { DevflowError } from "./errors.js";

export type PromptStage = "explore" | "design" | "implement" | "small" | "verify";

/** Placeholders a template may use. Unknown placeholders are an error, missing values become empty. */
export interface PromptInputs {
  id: string;
  description: string;
  tracker?: string;
  language: string;
  /** Paths the role should write, in words. */
  outputs: string;
  /** Inlined context blocks prepared by the stage. */
  context: string;
  testCommand: string;
  round?: number;
  previousVerdict?: string;
}

const COMMON_HEADER = `You are the {{role}} role in a devflow task. Other roles plan, implement and verify; you do only your part.
Task id: {{id}}{{tracker}}
Task: {{description}}
Write every human-readable artifact in language: {{language}}. Keep code, paths, commands and identifiers as they are.
Only write the files named under "Outputs". Writes elsewhere are blocked or discarded.

`;

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
- tasks.md: numbered groups with "- [ ] X.Y" checkbox tasks, each saying how it is verified.
Rewrite every spec delta you keep; delete deltas that no longer apply.

{{context}}

Outputs: {{outputs}}
`,
  implement:
    COMMON_HEADER.replace("{{role}}", "IMPLEMENT") +
    `Goal: implement the approved plan. Follow tasks.md in order, write tests first where the test plan names them, and tick each finished task in tasks.md ("- [x]").
Stay inside the impact zone. You may run the test command: {{testCommand}}
Do not edit proposal.md, design.md or spec deltas; if the plan is wrong, stop and say so in your final message.

{{context}}

Outputs: {{outputs}}
`,
  small:
    COMMON_HEADER.replace("{{role}}", "IMPLEMENT (small task)") +
    `Goal: make the small change described above, with a test that fails without it and passes with it.
You may run the test command: {{testCommand}}

{{context}}

Outputs: {{outputs}}
`,
  verify:
    COMMON_HEADER.replace("{{role}}", "VERIFY") +
    `Goal: independently check the implemented change against its acceptance criteria. You did not plan or write it, and you are working in a disposable copy of the project: edits you make are discarded.
Acceptance criteria are the requirements and scenarios in the spec deltas below. You may read the changed files and run: {{testCommand}}
For every requirement decide MET, PARTIAL or NOT MET with file:line evidence. Look for tests that would still pass if the code were wrong.
design.md and the .devflow/ folder are intentionally absent from this copy (you judge the result, not the author's reasoning); do not report their absence or their deletion in git status.
Verdict rule: REWORK only for at least one high or medium finding; HUMAN when you cannot judge; otherwise PASS, listing low findings as notes.
{{roundRule}}
Write the verdict file in English, first line exactly one of: "VERDICT: PASS", "VERDICT: REWORK", "VERDICT: HUMAN". Then a table requirement | status | evidence, then numbered findings (severity high/medium/low, file:line, concrete fix). REWORK needs at least one concrete fix. No praise.

{{context}}
{{previousVerdict}}
Outputs: {{outputs}}
`,
};

const ROUND2_RULE = `This is round {{round}}. Report ONLY high-severity findings and regressions of findings from the previous verdict below. Do not raise new medium or low findings.`;

const KNOWN = new Set(["role", "id", "tracker", "description", "language", "outputs", "context", "testCommand", "roundRule", "previousVerdict", "round"]);

export function loadTemplate(root: string, stage: PromptStage): string {
  const override = join(root, DEVFLOW_DIR, "prompts", `${stage}.md`);
  if (existsSync(override)) return readFileSync(override, "utf8");
  return TEMPLATES[stage];
}

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
