/** @file Exercise base, zone and gate commands against disposable Git projects. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitProject, write } from "./gitrepo.js";
import { loadTask, saveTask } from "../src/store.js";
import { pathHashes } from "../src/snapshot.js";

/** Path to the built CLI entry used by subprocess-based tests. */
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
/** Execute the compiled CLI in the fixture and return captured output and exit status. */
const devflow = (cwd: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
/** Load the task's persisted JSON so assertions can inspect transitions and counters. */
const state = (root: string, id: string) => JSON.parse(readFileSync(join(root, ".devflow", "runs", id, "state.json"), "utf8"));

test("start records base and zone; zone --from-design and base update them", () => {
  const { root, base } = gitProject();
  assert.equal(devflow(root, "start", "t1", "X", "--zone", "src/**", "--zone", "tests/**").code, 0);
  assert.deepEqual([state(root, "t1").base, state(root, "t1").zone], [base, ["src/**", "tests/**"]]);
  write(root, "design.md", "## Impact zone\n- `lib/**`\n");
  assert.equal(devflow(root, "zone", "t1", "--from-design", "design.md").code, 0);
  assert.deepEqual(state(root, "t1").zone, ["lib/**"]);
  assert.equal(devflow(root, "base", "t1", "HEAD").code, 0);
  assert.equal(devflow(root, "base", "t1", "nope", "--json").code, 1);
});

test("gate all records the result only when gates is next; single gates never change state", () => {
  const { root } = gitProject();
  devflow(root, "start", "s1", "fix", "--tier", "small", "--zone", "src/**", "--zone", "tests/**");
  write(root, "src/math.js", "exports.add = (a, b) => a + b;\nexports.mul = (a, b) => a * b;\n");
  write(root, "tests/mul.test.js", "const { mul } = require('../src/math'); if (mul(2, 3) !== 6) throw new Error('mul');\n");

  const early = devflow(root, "gate", "s1", "zone");
  assert.equal(JSON.parse(early.out).recorded, false);
  assert.equal(state(root, "s1").status, "NEW");

  devflow(root, "complete", "s1", "implement", "ok");
  const r = devflow(root, "gate", "s1");
  const out = JSON.parse(r.out);
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(out.results.map((x: { name: string; outcome: string }) => `${x.name}:${x.outcome}`), ["zone:pass", "tests:pass", "rollback:pass"]);
  assert.equal(out.recorded, true);
  assert.equal(state(root, "s1").status, "DONE");
});

test("gate records a pass and reports the unchanged dirty path as a warning", () => {
  const { root } = gitProject();
  assert.equal(devflow(root, "start", "t1", "Add mul", "--tier", "small", "--zone", "src/**", "--zone", "tests/**").code, 0);
  write(root, "README.md", "human edit");
  assert.equal(devflow(root, "complete", "t1", "implement", "ok").code, 0);
  const task = loadTask(root, "t1");
  task.dirtyAtImplement = { at: task.updatedAt, paths: pathHashes(root, ["README.md"]) };
  saveTask(root, task);
  write(root, "src/math.js", "exports.add = (a, b) => a + b; exports.mul = (a, b) => a * b;");
  write(root, "tests/mul.test.js", "if (require('../src/math').mul(2, 3) !== 6) throw new Error('mul');");

  const result = devflow(root, "gate", "t1");
  assert.equal(result.code, 0, result.out + result.err);
  const out = JSON.parse(result.out);
  assert.equal(out.recorded, true);
  assert.deepEqual(out.results[0].warnings, ["preexisting_change:README.md"]);
  const finished = loadTask(root, "t1");
  assert.equal(finished.status, "DONE");
  assert.equal(finished.history.some((h) => h.reason === "zone_violation"), false);
});

test("a zone violation through gate all escalates the task", () => {
  const { root } = gitProject();
  devflow(root, "start", "s2", "fix", "--tier", "small", "--zone", "src/**");
  write(root, "README.md", "oops\n");
  devflow(root, "complete", "s2", "implement", "ok");
  const r = devflow(root, "gate", "s2");
  assert.equal(r.code, 1);
  assert.deepEqual(JSON.parse(r.out).skipped, ["tests", "rollback"]);
  assert.equal(state(root, "s2").tier, "medium");
});

test("complete gates ok needs --override", () => {
  const { root } = gitProject();
  devflow(root, "start", "s3", "fix", "--tier", "small");
  devflow(root, "complete", "s3", "implement", "ok");
  const refused = devflow(root, "complete", "s3", "gates", "ok", "--json");
  assert.deepEqual([refused.code, JSON.parse(refused.err).error.reason], [1, "gates_need_gate_run"]);
  assert.equal(devflow(root, "complete", "s3", "gates", "ok", "--override", "manual check").code, 0);
});
