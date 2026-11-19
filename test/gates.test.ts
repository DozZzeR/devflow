/** @file Check scope enforcement and the baseline, tests-only and full-change phases using Git fixtures. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { initProject, loadConfig, type Config } from "../src/config.js";
import { rollbackGate, runAllGates, testsGate, zoneGate } from "../src/gates.js";
import { parseImpactZone } from "../src/zone.js";
import { newTask, type TaskState, type Tier } from "../src/lifecycle.js";
import { DevflowError } from "../src/errors.js";
import { gitProject, sh, write } from "./gitrepo.js";
import { NOW, tempDir } from "./helpers.js";

/** Assemble gate inputs for a temporary repository and a selected base commit. */
function ctx(root: string, base: string | undefined, opts: { zone?: string[]; tier?: Tier; config?: (c: Config) => void } = {}) {
  const task: TaskState = newTask("t1", "x", opts.tier ?? "medium", undefined, NOW);
  if (base) task.base = base;
  if (opts.zone) task.zone = opts.zone;
  const config = loadConfig(root);
  opts.config?.(config);
  return { root, task, config };
}


test("impact zone parsing: list items, backticks, stops at next heading", () => {
  const md = "# Design\n\n## Impact zone\n\n- `src/**`\n* test/**\n\n## Test plan\n- not/this\n";
  assert.deepEqual(parseImpactZone(md), ["src/**", "test/**"]);
  assert.throws(() => parseImpactZone("# none"), (e: unknown) => e instanceof DevflowError && e.reason === "no_zone_section");
  assert.throws(() => parseImpactZone("## Impact zone\n- ../x\n"), (e: unknown) => e instanceof DevflowError && e.reason === "invalid_zone");
});

test("zone gate: pass inside, fail lists outsiders, blocked without zone on medium, warning on small", () => {
  const { root, base } = gitProject();
  write(root, "src/math.js", "changed\n");
  write(root, "README.md", "x\n");
  assert.equal(zoneGate(ctx(root, base, { zone: ["src/**", "README.md"] })).outcome, "pass");
  const f = zoneGate(ctx(root, base, { zone: ["src/**"] }));
  assert.deepEqual([f.outcome, (f.details as { outside: string[] }).outside], ["fail", ["README.md"]]);
  assert.deepEqual([zoneGate(ctx(root, base)).outcome, zoneGate(ctx(root, base)).reason], ["blocked", "no_zone"]);
  const small = zoneGate(ctx(root, base, { tier: "small" }));
  assert.deepEqual([small.outcome, small.warnings], ["pass", ["no_zone"]]);
});

test("generated outputs join an existing impact zone", () => {
  const { root, base } = gitProject();
  write(root, "src/a.ts", "export {};\n");
  write(root, "plugins/x/index.js", "generated\n");
  const zone = ["src/**"];
  /** Configure a generated path used by the zone gate fixture. */
  const withOutput = (output: string) => (c: Config) => {
    c.build = { generate: "node gen.mjs", outputs: [output] };
  };
  const config = withOutput("plugins/**");
  for (const output of ["plugins/**", "./plugins/**", "././plugins/**"]) {
    const result = zoneGate(ctx(root, base, { zone, config: withOutput(output) }));
    assert.equal(result.outcome, "pass", JSON.stringify({ output, result }));
    assert.deepEqual(result.details, { changed: 2 });
  }
  assert.equal(zoneGate(ctx(root, base, { zone: ["././src/**"], config })).outcome, "pass");
  assert.deepEqual(zone, ["src/**"]);
  const withoutBuild = zoneGate(ctx(root, base, { zone }));
  assert.equal(withoutBuild.outcome, "fail");
  assert.deepEqual(withoutBuild.details, { outside: ["plugins/x/index.js"] });
  const noZone = zoneGate(ctx(root, base, { config }));
  assert.deepEqual([noZone.outcome, noZone.reason], ["blocked", "no_zone"]);
});

test("gates are blocked without git or without a base", () => {
  const { root } = gitProject();
  const noBase = zoneGate(ctx(root, undefined, { zone: ["**"] }));
  assert.deepEqual([noBase.outcome, noBase.reason], ["blocked", "no_base"]);
  const plain = tempDir();
  initProject(plain);
  const noGit = zoneGate(ctx(plain, "abc", { zone: ["**"] }));
  assert.deepEqual([noGit.outcome, noGit.reason], ["blocked", "no_git"]);
});

test("rollback: real regression test passes and leaves the working tree untouched", async () => {
  const { root, base } = gitProject();
  write(root, "src/math.js", "exports.add = (a, b) => a + b;\nexports.mul = (a, b) => a * b;\n");
  write(root, "tests/mul.test.js", "const { mul } = require('../src/math'); if (mul(2, 3) !== 6) throw new Error('mul');\n");
  const before = sh(root, "git", ["status", "--porcelain"]);
  const r = await rollbackGate(ctx(root, base));
  assert.equal(r.outcome, "pass", JSON.stringify(r));
  assert.equal(sh(root, "git", ["status", "--porcelain"]), before);
  assert.equal(sh(root, "git", ["worktree", "list"]).trim().split("\n").length, 1);
});

test("rollback regenerates only in the worktree and cleans up after failure", async () => {
  const { root } = gitProject();
  write(root, "src/value.txt", "old");
  write(root, "out/bundle.txt", "old");
  write(root, "gen.mjs", `
    import { copyFileSync, existsSync, readFileSync } from 'node:fs';
    const testFile = 'tests/bundle.test.js';
    if (!existsSync(testFile) || !readFileSync(testFile, 'utf8').includes('// gen-marker')) {
      process.exit(1);
    }
    copyFileSync('src/value.txt', 'out/bundle.txt');
  `);
  sh(root, "git", ["add", "-A"]);
  sh(root, "git", ["commit", "-qm", "generator fixture"]);
  const base = sh(root, "git", ["rev-parse", "HEAD"]).trim();
  write(root, "src/value.txt", "new");
  write(root, "tests/bundle.test.js", `
    // gen-marker
    const { readFileSync } = require('node:fs');
    const assert = require('node:assert/strict');
    const value = readFileSync('src/value.txt', 'utf8');
    assert.equal(value, 'new');
    assert.equal(readFileSync('out/bundle.txt', 'utf8'), value);
  `);
  const status = sh(root, "git", ["status", "--porcelain"]);
  const worktrees = sh(root, "git", ["worktree", "list", "--porcelain"]);
  /** Build a gate context whose generation command can be changed between runs. */
  const withGenerate = (generate: string) => ctx(root, base, { config: (c) => { c.build = { generate, outputs: ["out/**"] }; } });

  const generated = await rollbackGate(withGenerate("node gen.mjs"));
  assert.equal(generated.outcome, "pass", JSON.stringify(generated));
  const { logs } = generated.details as { logs: string[] };
  assert.match(logs[1]!, /gate_rollback_generate/);
  assert.match(logs[3]!, /gate_rollback_generate/);
  for (const log of [logs[1]!, logs[3]!]) {
    const cwd = readFileSync(log, "utf8").match(/^# cwd: (.+)$/m)?.[1];
    assert.ok(cwd);
    assert.notEqual(cwd, root);
  }
  const stale = await rollbackGate(ctx(root, base));
  assert.deepEqual([stale.outcome, stale.reason], ["fail", "tests_fail_with_change"]);
  const failed = await rollbackGate(withGenerate('node -e "process.exit(1)"'));
  assert.deepEqual([failed.outcome, failed.reason], ["blocked", "generate_failed"]);
  assert.match((failed.details as { logs: string[] }).logs.at(-1)!, /gate_rollback_generate/);
  assert.equal(readFileSync(join(root, "out", "bundle.txt"), "utf8"), "old");
  assert.equal(sh(root, "git", ["status", "--porcelain"]), status);
  assert.equal(sh(root, "git", ["worktree", "list", "--porcelain"]), worktrees);
});

test("rollback: a test that passes without the change checks nothing", async () => {
  const { root, base } = gitProject();
  write(root, "src/math.js", "exports.add = (a, b) => a + b;\nexports.mul = (a, b) => a * b;\n");
  write(root, "tests/weak.test.js", "if (1 + 1 !== 2) throw new Error('never');\n");
  const r = await rollbackGate(ctx(root, base));
  assert.deepEqual([r.outcome, r.reason], ["fail", "tests_check_nothing"]);
});

test("rollback: no test files → fail no_tests; broken baseline → blocked", async () => {
  const { root, base } = gitProject();
  write(root, "src/math.js", "exports.add = (a, b) => a - b;\n");
  const r = await rollbackGate(ctx(root, base));
  assert.deepEqual([r.outcome, r.reason], ["fail", "no_tests"]);

  const p2 = gitProject();
  write(p2.root, "tests/new.test.js", "throw new Error('red');\n");
  const broken = await rollbackGate(ctx(p2.root, p2.base, { config: (c) => (c.test.command = "node does-not-exist.js") }));
  assert.deepEqual([broken.outcome, broken.reason], ["blocked", "baseline_failed"]);
});

test("rollback: setup runs, and again when a setup input changed; red_exit_codes narrows red", async () => {
  const { root, base } = gitProject();
  write(root, "src/math.js", "exports.add = (a, b) => a + b;\nexports.mul = (a, b) => a * b;\n");
  write(root, "tests/mul.test.js", "const { mul } = require('../src/math'); if (mul(2, 3) !== 6) throw new Error('mul');\n");
  write(root, "package.json", "{}\n");
  const setup = "node -e \"require('fs').appendFileSync('setup.log','x')\"";
  const r = await rollbackGate(ctx(root, base, { config: (c) => (c.test.setup = setup) }));
  assert.equal(r.outcome, "pass", JSON.stringify(r));
  const logs = (r.details as { logs: string[] }).logs;
  assert.equal(logs.filter((l) => /gate_rollback_setup/.test(l)).length, 2);

  const narrow = await rollbackGate(ctx(root, base, { config: (c) => (c.test.red_exit_codes = [7]) }));
  assert.deepEqual([narrow.outcome, narrow.reason], ["blocked", "unexpected_exit_code"]);
});

test("tests gate and runAllGates stop at the first non-pass", async () => {
  const { root, base } = gitProject();
  write(root, "README.md", "x\n");
  const all = await runAllGates(ctx(root, base, { zone: ["src/**"] }));
  assert.deepEqual(all.results.map((r) => [r.name, r.outcome]), [["zone", "fail"]]);
  assert.deepEqual(all.skipped, ["tests", "rollback"]);
  assert.equal((await testsGate(ctx(root, base))).outcome, "pass");
  write(root, "tests/bad.test.js", "throw new Error('x');\n");
  assert.equal((await testsGate(ctx(root, base))).outcome, "fail");
  assert.ok(existsSync(root));
});

test("tests gate: a quoted command works and a timeout is blocked", async () => {
  const { root, base } = gitProject();
  const quoted = await testsGate(ctx(root, base, { config: (c) => (c.test.command = 'node -e "process.exit(0)"') }));
  assert.equal(quoted.outcome, "pass", JSON.stringify(quoted));
  const slow = await testsGate(ctx(root, base, { config: (c) => { c.test.command = 'node -e "setTimeout(()=>{},60000)"'; c.test.timeout_seconds = 2; } }));
  assert.deepEqual([slow.outcome, slow.reason], ["blocked", "test_run_error"]);
});

test("gates trust the config committed at the base, not a role-edited working copy", async () => {
  const { root, base } = gitProject();
  const { gateConfig } = await import("../src/gates.js");
  const working = loadConfig(root);
  working.test.command = "node -e \"process.exit(0)\"";
  const trusted = gateConfig(root, base, working);
  assert.deepEqual([trusted.source, trusted.config.test.command], ["base", "node check.js"]);
  const plain = tempDir();
  initProject(plain);
  assert.equal(gateConfig(plain, "abc", working).source, "working_tree");
});

test("operational errors become blocked results instead of exceptions", async () => {
  const { runGate } = await import("../src/gates.js");
  const { root } = gitProject();
  const r = await runGate("rollback", ctx(root, "0000000000000000000000000000000000000000"));
  assert.equal(r.outcome, "blocked");
  const z = await runGate("zone", ctx(root, "0000000000000000000000000000000000000000", { zone: ["**"] }));
  assert.equal(z.outcome, "blocked");
});

test("an uncommitted config that the change modified is not trusted", async () => {
  const { root, base } = gitProject();
  sh(root, "git", ["rm", "-q", "--cached", ".devflow/config.json"]);
  sh(root, "git", ["commit", "-q", "-m", "untrack config"]);
  const newBase = sh(root, "git", ["rev-parse", "HEAD"]).trim();
  const { gateConfig } = await import("../src/gates.js");
  assert.throws(() => gateConfig(root, newBase, loadConfig(root)), (e: unknown) => e instanceof DevflowError && e.reason === "untrusted_config");
  void base;
});

test("impact zone accepts +, ordered and nested list markers", () => {
  assert.deepEqual(parseImpactZone("## Impact zone\n+ a/**\n1. b/**\n2) c/**\n"), ["a/**", "b/**", "c/**"]);
});
