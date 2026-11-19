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
