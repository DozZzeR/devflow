import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkOutputs, claudeInvocation, claudeSettings, codexInvocation, commandInvocation, validateScope } from "../src/runners.js";
import { DevflowError } from "../src/errors.js";
import { tempDir } from "./helpers.js";

const reason = (r: string) => (e: unknown) => e instanceof DevflowError && e.reason === r;

test("claude invocation: dontAsk, hook settings, scoped tools, bash denied when not allowed", () => {
  const inv = claudeInvocation({ role: { runner: "claude", model: "sonnet" }, write: ["src/**"], bash: [] }, "S.json");
  assert.equal(inv.scope, "enforced");
  assert.deepEqual(inv.args, [
    "-p", "--model", "sonnet", "--output-format", "json", "--permission-mode", "dontAsk",
    "--no-session-persistence", "--settings", "S.json",
    "--allowedTools", "Read", "Grep", "Glob", "Edit(src/**)", "Write(src/**)", "MultiEdit(src/**)",
    "--disallowedTools", "Bash",
  ]);
  assert.ok(!inv.args.includes("--bare"));
  const withBash = claudeInvocation({ role: { runner: "claude", model: "m" }, write: ["a/**"], bash: ["npm test"] }, "S");
  assert.ok(withBash.args.includes("Bash(npm test)"));
  assert.ok(!withBash.args.includes("--disallowedTools"));
});

test("claude settings register the devflow PreToolUse hook for every tool", () => {
  const s = JSON.parse(claudeSettings("C:/p/scope.json", "C:/node.exe", "C:/d/cli.js"));
  const h = s.hooks.PreToolUse[0];
  assert.equal(h.matcher, "*");
  assert.equal(h.hooks[0].command, '"C:/node.exe" "C:/d/cli.js" hook pre-tool-use --scope-file "C:/p/scope.json"');
});

test("codex invocation: read-only without scope, workspace-write with scope, prompt from stdin", () => {
  const ro = codexInvocation({ role: { runner: "codex", model: "m1" }, write: [], root: "R" }, true);
  assert.deepEqual(ro.args, ["exec", "-m", "m1", "-s", "read-only", "--skip-git-repo-check", "--ephemeral", "-C", "R", "--ignore-user-config", "-"]);
  assert.equal(ro.scope, "sandbox");
  const rw = codexInvocation({ role: { runner: "codex", model: "m1" }, write: ["x/**"], root: "R" }, false);
  assert.ok(rw.args.includes("workspace-write"));
  assert.ok(!rw.args.includes("--ignore-user-config"));
});

test("command template expands known placeholders and rejects others", () => {
  const inv = commandInvocation('opencode run --model {model} --file "{prompt_file}" -C {cwd}', { model: "m", prompt_file: "p f.md", cwd: "/w" });
  assert.deepEqual([inv.command, ...inv.args], ["opencode", "run", "--model", "m", "--file", "p f.md", "-C", "/w"]);
  assert.equal(inv.scope, "advisory");
  assert.throws(() => commandInvocation("x {secret}", { model: "", prompt_file: "", cwd: "" }), reason("invalid_template"));
});

test("scope validation: no shell in read-only runs, no escaping globs", () => {
  assert.throws(() => validateScope([], ["npm test"]), reason("invalid_scope"));
  assert.throws(() => validateScope(["../x/**"], []), reason("invalid_scope"));
  validateScope(["src/**"], ["npm test"]);
  validateScope([], []);
});

test("outputs: missing, empty, stale, outside project; new and changed files pass", () => {
  const root = tempDir();
  mkdirSync(join(root, "o"));
  writeFileSync(join(root, "o", "stale.json"), "old");
  writeFileSync(join(root, "o", "changed.json"), "old");
  const h = (v: string) => createHash("sha256").update(v).digest("hex");
  const before = new Map([
    ["o/stale.json", { exists: true, size: 3, hash: h("old") }],
    ["o/changed.json", { exists: true, size: 3, hash: h("old") }],
  ]);
  writeFileSync(join(root, "o", "changed.json"), "new!");
  writeFileSync(join(root, "o", "new.json"), "{}");
  writeFileSync(join(root, "o", "empty.json"), "");
  const problems = checkOutputs(root, ["o/stale.json", "o/changed.json", "o/new.json", "o/empty.json", "o/none.json", "../out.json"], before);
  assert.deepEqual(problems, [
    { path: "o/stale.json", problem: "stale" },
    { path: "o/empty.json", problem: "empty" },
    { path: "o/none.json", problem: "missing" },
    { path: "../out.json", problem: "outside_project" },
  ]);
});

test("API keys listed in env.pass are dropped unless the runner opts in", async () => {
  const { passNames } = await import("../src/runners.js");
  const { config: cfg } = await import("./helpers.js");
  const c = cfg();
  c.runners.env.pass = ["HTTPS_PROXY", "openai_api_key", "ANTHROPIC_API_KEY"];
  assert.deepEqual(passNames(c, "codex"), { names: ["HTTPS_PROXY"], apiKeyEnv: "stripped" });
  c.runners.codex.use_api_key = true;
  assert.deepEqual(passNames(c, "codex"), { names: ["HTTPS_PROXY", "OPENAI_API_KEY"], apiKeyEnv: "kept" });
  assert.deepEqual(passNames(c, "claude").names, ["HTTPS_PROXY"]);
});

test("drive-relative write globs are rejected", () => {
  assert.throws(() => validateScope(["C:src/**"], []), reason("invalid_scope"));
});
