/** @file Exercise vendor-specific detection of subscription limits and reset hints. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { detectUsageLimit } from "../src/limits.js";

test("Claude usage limit extracts reset text from the final JSON object", () => {
  assert.deepEqual(detectUsageLimit("claude", '{"api_error":"usage_limit_reached","result":"Usage limit reached, resets 5pm"}\ntrailing text', 0), {
    runner: "claude", reset: "5pm",
  });
});

test("Claude 429 can have no reset", () => {
  assert.deepEqual(detectUsageLimit("claude", '{"api_error_status":429}', 0), { runner: "claude" });
});

test("Claude epoch reset becomes an ISO timestamp", () => {
  assert.deepEqual(detectUsageLimit("claude", '{"api_error":"usage_limit_reached","result":"Usage limit reached|1763571600"}', 0), {
    runner: "claude", reset: "2025-11-19T17:00:00.000Z",
  });
});

test("ordinary Claude errors and command runners are never classified from free text", () => {
  assert.equal(detectUsageLimit("claude", '{"is_error":true,"result":"Error 429: usage limit"}', 1), undefined);
  assert.equal(detectUsageLimit("command", "ERROR: usage limit", 1), undefined);
});

test("Codex detects a limit on a failed run and extracts its reset", () => {
  assert.deepEqual(detectUsageLimit("codex", "ERROR: You've hit your usage limit. Try again at 5:00 PM.\n", 1), {
    runner: "codex", reset: "5:00 PM",
  });
  assert.deepEqual(detectUsageLimit("codex", "Error: HTTP 429\nTry again in 2 hours.\n", 1), {
    runner: "codex", reset: "2 hours",
  });
});

test("Codex ignores a limit in the prompt and a 429 on a successful run", () => {
  assert.equal(detectUsageLimit("codex", `Diagnose an error reporting a usage limit\n${"prompt\n".repeat(58)}ERROR: ordinary failure`, 1), undefined);
  assert.equal(detectUsageLimit("codex", `ERROR: usage limit\n${"\n".repeat(50)}`, 1), undefined);
  assert.equal(detectUsageLimit("codex", "error 429", 0), undefined);
});

test("Timed-out Codex run is not a limit", () => {
  assert.equal(detectUsageLimit("codex", "ERROR: 429", null), undefined);
});

test("Punctuated reset preserves the dotted abbreviation", () => {
  assert.equal(detectUsageLimit("codex", "ERROR: You've hit your usage limit. Try again at 5 p.m. Upgrade now.", 1)?.reset, "5 p.m.");
});

test("Reset on a later line of the error is included", () => {
  const log = "ERROR: You've hit your usage limit.\nUsage is capped.\nUpgrade to Pro or try again at 5:00 PM.";
  assert.equal(detectUsageLimit("codex", log, 1)?.reset, "5:00 PM");
  assert.equal(detectUsageLimit("codex", log.replace("Usage is capped.", ""), 1)?.reset, undefined);
});

test("Decimal in the reset is preserved", () => {
  assert.equal(detectUsageLimit("codex", "ERROR: 429. Try again in 2.5 hours.", 1)?.reset, "2.5 hours");
});

test("A Claude run killed after printing a limit object is not a limit", () => {
  assert.equal(detectUsageLimit("claude", '{"api_error":"usage_limit_reached","result":"Usage limit reached, resets 5pm"}', null), undefined);
});

test("Two limit lines in one Codex error block keep the reset from the first", () => {
  const log = "earlier output\n\nERROR: You've hit your usage limit. Try again at 5:00 PM.\nERROR: HTTP 429\n";
  assert.equal(detectUsageLimit("codex", log, 1)?.reset, "5:00 PM");
  // A blank line ends the previous error: its reset does not leak into a later block.
  const two = "ERROR: usage limit. Try again at 1:00 PM.\n\nERROR: HTTP 429\n";
  assert.equal(detectUsageLimit("codex", two, 1)?.reset, undefined);
});
