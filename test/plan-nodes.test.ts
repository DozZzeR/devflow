/** @file Check OpenSpec task replacement and review decisions with sibling and fenced-example cases. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { planNodes, replaceNode, reviewDecisions, decidedFeedback } from "../src/plan-nodes.js";

test("Markdown samples do not become plan nodes or review findings", () => {
  const tasks = ["# Tasks", "- [ ] 1.1 implement", "", "~~~markdown", "- [ ] 1.1 sample", "~~~", ""].join("\n");
  assert.deepEqual([...planNodes(tasks).keys()], ["1.1"]);
  const verdict = "VERDICT: REWORK\n1. **High** broken\n\n~~~md\n2. sample\n~~~\n";
  assert.match(decidedFeedback([{ finding: "F1", action: "fix", node: "1.1", reason: "test it" }], verdict), /test it/);
  assert.throws(() => decidedFeedback([], verdict));
});

test("a scoped candidate cannot replace a sibling, a heading, or an unchanged node ID", () => {
  const tasks = "# Tasks\r\n\r\n- [ ] 1.1 Old\r\n  detail\r\n\r\n- [x] 1.2 Keep\r\n";
  assert.equal(replaceNode(tasks, "1.1", "- [ ] 1.1 New\n  checked by test\n"), tasks.replace("Old\r\n  detail", "New\r\n  checked by test"));
  for (const candidate of ["- [x] 1.1 Done", "- [ ] 1.1 New\n- [ ] 1.2 Hijack", "- [ ] 1.1 New\n## Section", "- [ ] 2.1 Other"]) {
    assert.throws(() => replaceNode(tasks, "1.1", candidate));
  }
  assert.throws(() => reviewDecisions(tasks + "## Review decisions (round 1)\n- F1 | fix | 9.9 | unknown"));
});

test("only the Findings section assigns IDs and a fix carries the original evidence", () => {
  const verdict = [
    "VERDICT: REWORK", "## Requirements", "1. Checked a requirement", "## Findings",
    "1. **High** src/export.ts:42 loses empty rows.", "   The final row is dropped.",
    "2) **Medium** UNAPPROVED-RAW-TEXT", "", "## Test run", "1. Ran the unit suite.", "2) Ran the CLI.",
  ].join("\n");
  const feedback = decidedFeedback([
    { finding: "F1", action: "fix", node: "1.1", reason: "Handle empty rows." },
    { finding: "F2", action: "dismiss", node: "-", reason: "Accepted by the owner." },
  ], verdict);
  assert.match(feedback, /src\/export\.ts:42 loses empty rows\./);
  assert.match(feedback, /The final row is dropped\./);
  assert.match(feedback, /Handle empty rows\./);
  assert.doesNotMatch(feedback, /UNAPPROVED-RAW-TEXT|unit suite|Checked a requirement/);
});

test("a saved verdict with an unheaded finding list ignores its subsequent test section", () => {
  const verdict = "VERDICT: REWORK\n1. **High** src/export.ts:42 drops a row.\n\n## Test run\n1) Ran tests.";
  const feedback = decidedFeedback([{ finding: "F1", action: "fix", node: "2.1", reason: "Keep the row." }], verdict);
  assert.match(feedback, /src\/export\.ts:42 drops a row/);
  assert.doesNotMatch(feedback, /Ran tests/);
});

test("ambiguous finding IDs belong to the verdict and a missing decision belongs to the plan", () => {
  const rows = [{ finding: "F1", action: "fix", node: "2.1", reason: "Keep the row." }] as const;
  for (const body of ["## Findings\n1. First\n1) Second", "## Findings\n1. First\n## Findings\n2. Second", "## Findings\n## Test run\n1. Ran tests", "## Test run\n1. **High** is a test selection label."]) {
    assert.throws(() => decidedFeedback([...rows], body), { reason: "invalid_verdict_findings" });
  }
  assert.throws(() => decidedFeedback([...rows], "## Findings\n1. First\n2. Second"), { reason: "invalid_plan_nodes" });
});

test("legacy severity-labelled findings under an older report title keep wrapped evidence", () => {
  const verdict = ["# Verification report", "## Requirements", "Requirements checked.", "",
    "1. **High** src/export.ts:42 drops a row", "when the last line is empty.", "",
    "## Test run", "1. Setup the suite."].join("\n");
  const feedback = decidedFeedback([{ finding: "F1", action: "fix", node: "2.1", reason: "Keep the row." }], verdict);
  assert.match(feedback, /when the last line is empty\./);
  assert.doesNotMatch(feedback, /Setup the suite/);
});
