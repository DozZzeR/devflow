/** @file Exercise role execution and diagnostics through the actual CLI using fake vendor executables. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeBin, testEnv } from "./fake.js";
import { tempDir } from "./helpers.js";

/** Path to the built CLI entry used by subprocess-based tests. */
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

/** Execute the compiled CLI in the fixture and return captured output and exit status. */
function devflow(cwd: string, env: NodeJS.ProcessEnv, args: string[], input = "") {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8", input });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

/** Project with a codex-only config whose fake CLI behaviour vars are passed through. */
function project(extraEnv: Record<string, string> = {}) {
  const root = tempDir();
  const bin = fakeBin(join(tempDir(), "bin"), ["codex", "claude"]);
  const env = testEnv(bin, { MEMPALACE_TOKEN: "secret-should-not-pass", ...extraEnv });
  assert.equal(devflow(root, env, ["init", "--runners", "codex"]).code, 0);
  const cfgPath = join(root, ".devflow", "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.runners = { env: { pass: ["FAKE_RECORD", "FAKE_WRITE", "FAKE_EXIT", "FAKE_PRINT", "FAKE_SLEEP"] } };
  writeFileSync(cfgPath, JSON.stringify(cfg));
  writeFileSync(join(root, "prompt.md"), "Do the thing");
  return { root, env };
}

test("exec-role runs codex with the prompt on stdin, allowlisted env, log and fresh output", () => {
  const record = join(tempDir(), "rec.json");
  const { root, env } = project({ FAKE_RECORD: record, FAKE_WRITE: ".devflow/runs/t1/verdict.json", FAKE_PRINT: "Authorization: Bearer abcdefghijklmnop" });
  const r = devflow(root, env, ["exec-role", "verify", "--prompt-file", "prompt.md", "--task", "t1", "--expect", ".devflow/runs/t1/verdict.json", "--timeout", "60"]);
  assert.equal(r.code, 0, r.err || r.out);
  const result = JSON.parse(r.out);
  assert.deepEqual([result.ok, result.runner, result.scope, result.apiKeyEnv], [true, "codex", "sandbox", "stripped"]);
  const rec = JSON.parse(readFileSync(record, "utf8"));
  assert.equal(rec.stdin, "Do the thing");
  assert.equal(rec.args[0], "exec");
  assert.ok(rec.args.includes("read-only"));
  assert.ok(!rec.envKeys.includes("MEMPALACE_TOKEN"), "secret leaked into child env");
  assert.ok(rec.envKeys.includes("FAKE_RECORD"));
  const log = readFileSync(result.log, "utf8");
  assert.match(log, /Bearer \[REDACTED\]/);
  assert.match(result.log.replace(/\\/g, "/"), /\.devflow\/runs\/t1\/logs\/verify-1\.log$/);
});

test("exec-role fails when the expected output is missing even if the CLI exits 0", () => {
  const { root, env } = project();
  const r = devflow(root, env, ["exec-role", "verify", "--prompt-file", "prompt.md", "--expect", "out.json", "--timeout", "60"]);
  assert.equal(r.code, 1);
  assert.deepEqual(JSON.parse(r.out).missingOutputs, [{ path: "out.json", problem: "missing" }]);
});

test("exec-role rejects shell in a read-only run, unknown roles and escaping task ids", () => {
  const { root, env } = project();
  /** Extract the machine-readable domain reason from a CLI error response. */
  const reasonOf = (r: { err: string }) => JSON.parse(r.err).error.reason;
  assert.equal(reasonOf(devflow(root, env, ["exec-role", "verify", "--prompt-file", "prompt.md", "--allow-bash", "npm test", "--json"])), "invalid_scope");
  assert.equal(reasonOf(devflow(root, env, ["exec-role", "nope", "--prompt-file", "prompt.md", "--json"])), "unknown_role");
  assert.equal(reasonOf(devflow(root, env, ["exec-role", "verify", "--prompt-file", "prompt.md", "--task", "../x", "--json"])), "invalid_id");
});

test("repeated flags are all collected", () => {
  const record = join(tempDir(), "rec.json");
  const { root, env } = project({ FAKE_RECORD: record, FAKE_WRITE: "a.txt;b.txt" });
  const r = devflow(root, env, ["exec-role", "implement", "--prompt-file", "prompt.md", "--write", "a.txt", "--write", "b.txt", "--expect", "a.txt", "--expect", "b.txt", "--timeout", "60"]);
  assert.equal(r.code, 0, r.out + r.err);
  const rec = JSON.parse(readFileSync(record, "utf8"));
  assert.ok(rec.args.includes("workspace-write"));
});

test("doctor reports CLIs and roles needing a missing CLI", () => {
  const root = tempDir();
  const bin = fakeBin(join(tempDir(), "bin"), ["codex"]);
  const env = testEnv(bin);
  devflow(root, env, ["init", "--runners", "mixed"]);
  const r = devflow(root, env, ["doctor", "--json"]);
  assert.equal(r.code, 1);
  const report = JSON.parse(r.out);
  const codex = report.clis.find((c: { name: string }) => c.name === "codex");
  assert.deepEqual([codex.version, codex.login], ["fake-cli 1.0.0", "Logged in (fake)"]);
  assert.ok(report.missing.some((m: { role: string }) => m.role === "design"));
});

test("doctor --probe covers every distinct runner/model pair", () => {
  const { root, env } = project();
  const r = devflow(root, env, ["doctor", "--probe", "--json"]);
  const report = JSON.parse(r.out);
  const pairs = report.probes.map((p: { runner: string; model: string }) => `${p.runner}/${p.model}`);
  const cfg = JSON.parse(readFileSync(join(root, ".devflow", "config.json"), "utf8"));
  const expected = [...new Set(Object.values(cfg.roles).map((x) => `${(x as any).runner}/${(x as any).model}`))].sort();
  assert.deepEqual(pairs, expected);
  assert.ok(report.probes.every((p: { ok: boolean }) => p.ok));
});

test("init detects a codex-only machine from PATH", () => {
  const root = tempDir();
  const env = testEnv(fakeBin(join(tempDir(), "bin"), ["codex"]));
  assert.match(devflow(root, env, ["init"]).out, /runners: codex/);
});

test("hook command reads Claude's event on stdin", () => {
  const root = tempDir();
  const scope = join(root, "scope.json");
  writeFileSync(scope, JSON.stringify({ root, write: ["src/**"], bash: [] }));
  const r = devflow(root, process.env, ["hook", "pre-tool-use", "--scope-file", scope], JSON.stringify({ tool_name: "Write", tool_input: { file_path: "x.md" } }));
  assert.equal(JSON.parse(r.out).hookSpecificOutput.permissionDecision, "deny");
});

test("login summary hides personal data from JSON status", async () => {
  const { loginSummary } = await import("../src/doctor.js");
  assert.equal(loginSummary(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro", email: "a@b.c" })), "logged in via claude.ai (pro)");
  assert.equal(loginSummary("Logged in using ChatGPT\nmore"), "Logged in using ChatGPT");
});
