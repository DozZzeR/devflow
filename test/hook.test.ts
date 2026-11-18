import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { decide, runHook, type Scope } from "../src/hook.js";
import { tempDir } from "./helpers.js";

const root = resolve("/proj");
const scope: Scope = { root, write: ["src/**", "openspec/changes/x/tasks.md"], bash: ["npm test"] };
const allowed = (tool: string, input: Record<string, unknown>) => decide(scope, tool, input).allow;

test("read-only tools are allowed", () => {
  for (const t of ["Read", "Glob", "Grep", "LS", "TodoWrite"]) assert.equal(allowed(t, {}), true, t);
});

test("edits inside the scope are allowed, outside are denied", () => {
  assert.equal(allowed("Edit", { file_path: "src/a.ts" }), true);
  assert.equal(allowed("Write", { file_path: join(root, "src", "deep", "b.ts") }), true);
  assert.equal(allowed("MultiEdit", { file_path: "openspec/changes/x/tasks.md" }), true);
  assert.equal(allowed("Edit", { file_path: "README.md" }), false);
  assert.equal(allowed("Write", { file_path: "src/../README.md" }), false);
  assert.equal(allowed("Edit", { file_path: "../other/src/a.ts" }), false);
  assert.equal(allowed("Edit", { file_path: resolve("/elsewhere/src/a.ts") }), false);
  assert.equal(allowed("NotebookEdit", { notebook_path: "nb.ipynb" }), false);
  assert.equal(allowed("Edit", {}), false);
});

test("bash: only exact allowed commands", () => {
  assert.equal(allowed("Bash", { command: "npm test" }), true);
  assert.equal(allowed("Bash", { command: "npm test && rm -rf /" }), false);
  assert.equal(allowed("Bash", { command: "ls" }), false);
});

test("unknown and MCP tools are denied", () => {
  assert.equal(allowed("mcp__github__create_issue", {}), false);
  assert.equal(allowed("SomeNewTool", {}), false);
});

test("runHook prints Claude PreToolUse decisions", () => {
  const f = join(tempDir(), "scope.json");
  writeFileSync(f, JSON.stringify(scope));
  const deny = JSON.parse(runHook(f, JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "README.md" } })));
  assert.equal(deny.hookSpecificOutput.permissionDecision, "deny");
  assert.match(deny.hookSpecificOutput.permissionDecisionReason, /outside this role's write scope/);
  const allow = JSON.parse(runHook(f, JSON.stringify({ tool_name: "Read", tool_input: { file_path: "x" } })));
  assert.equal(allow.hookSpecificOutput.permissionDecision, "allow");
  assert.equal(JSON.parse(runHook(f, "not json")).hookSpecificOutput.permissionDecision, "deny");
});
