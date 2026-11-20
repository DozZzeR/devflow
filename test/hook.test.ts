/** @file Check tool permissions, path resolution and denial responses for the Claude scope hook. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { decide, runHook, type Scope } from "../src/hook.js";
import { tempDir } from "./helpers.js";

/** Fixture project root used to resolve hook paths in scope assertions. */
const root = resolve("/proj");
/** Write and shell permissions exercised by the hook decisions. */
const scope: Scope = { root, write: ["src/**", "openspec/changes/x/tasks.md"], bash: ["npm test"] };
/** Read the boolean decision returned for a simulated tool invocation. */
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

/** Scope with a focused test command in addition to the exact full command. */
const focusedScope: Scope = {
  ...scope,
  focused: { template: "node scripts/test-focused.mjs {files}", paths: ["test/**"] },
};
/** Decision for a Bash command under the focused scope. */
const focusedAllowed = (command: string) => decide(focusedScope, "Bash", { command }).allow;

test("bash: a focused command with test files is allowed, anything else is denied", () => {
  const P = "node scripts/test-focused.mjs";
  assert.equal(focusedAllowed(`${P} test/hook.test.ts test/config.test.ts`), true);
  assert.equal(focusedAllowed("npm test"), true);
  for (const bad of [
    `${P} src/hook.ts`, `${P} test/../src/hook.ts`, `${P} test/a.ts && rm -rf src`, `${P} test/a.ts;rm`,
    `${P} test/a.ts | cat`, `${P} test/a.ts\nrm x`, `${P} $(x)`, `${P} "test/a.ts"`, `${P} test/*.ts`, `${P} -r x`,
    P, `${P} {files}`, "node scripts/test-focused.mjs {files}", "ls",
  ]) assert.equal(focusedAllowed(bad), false, JSON.stringify(bad));
  const denied = decide(focusedScope, "Bash", { command: `${P} src/hook.ts` });
  assert.ok(!denied.allow && /shell command not allowed/.test(denied.reason));
});

test("bash without a focused entry keeps exact matching", () => {
  assert.equal(allowed("Bash", { command: "node scripts/test-focused.mjs test/a.ts" }), false);
});

test("runHook honours a focused entry in the scope file", () => {
  const f = join(tempDir(), "scope.json");
  writeFileSync(f, JSON.stringify(focusedScope));
  const run = (command: string) =>
    JSON.parse(runHook(f, JSON.stringify({ tool_name: "Bash", tool_input: { command } }))).hookSpecificOutput.permissionDecision;
  assert.equal(run("node scripts/test-focused.mjs test/x.test.ts"), "allow");
  assert.equal(run("node scripts/test-focused.mjs src/x.ts"), "deny");
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

test("hook fails closed on a broken scope file or event", () => {
  const f = join(tempDir(), "scope.json");
  writeFileSync(f, "{ not json");
  const d = JSON.parse(runHook(f, JSON.stringify({ tool_name: "Read", tool_input: {} })));
  assert.equal(d.hookSpecificOutput.permissionDecision, "deny");
  assert.match(d.hookSpecificOutput.permissionDecisionReason, /hook error/);
  assert.equal(JSON.parse(runHook(join(tempDir(), "missing.json"), "{}")).hookSpecificOutput.permissionDecision, "deny");
});

test("a linked directory inside the scope cannot redirect a write outside the project", (t) => {
  const proj = tempDir();
  const outsideDir = tempDir();
  mkdirSync(join(proj, "src"));
  try {
    symlinkSync(outsideDir, join(proj, "src", "link"), "junction");
  } catch {
    t.skip("cannot create links here");
    return;
  }
  const s: Scope = { root: proj, write: ["src/**"], bash: [] };
  assert.equal(decide(s, "Write", { file_path: "src/real.ts" }).allow, true);
  assert.equal(decide(s, "Write", { file_path: "src/link/evil.ts" }).allow, false);
});
