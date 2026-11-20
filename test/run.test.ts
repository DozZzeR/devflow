/** @file Drive the full CLI workflow against a local stand-in and inspect persisted state, artifacts and prompts. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { removeDetached } from "../src/git.js";
import { runNextStage } from "../src/stages.js";
import { fakeAgentBin } from "./fake.js";
import { gitProject, sh, write } from "./gitrepo.js";
import { tempDir } from "./helpers.js";

/** Path to the built CLI entry used by subprocess-based tests. */
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

/** Initialize the disposable project, fake executables and command helpers used by this suite. */
function setup(extra: Record<string, string> = {}, prepare?: (root: string, cfg: any) => void) {
  const { root } = gitProject();
  const cfgPath = join(root, ".devflow", "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.openspec = { cli: "off" };
  cfg.runners = { env: { pass: ["FAKE_VERDICT", "FAKE_VERIFY_EDIT", "FAKE_PROMPT_DIR", "FAKE_FAIL_ROLE", "FAKE_PLAN_CONFLICT", "FAKE_VERDICT_IN_ANSWER", "FAKE_BLOCKED", "FAKE_LIMIT_ROLE", "FAKE_LIMIT_OUTPUT", "FAKE_IMPLEMENT_TOUCH"] } };
  prepare?.(root, cfg);
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  sh(root, "git", ["add", "-A"]);
  sh(root, "git", ["commit", "-q", "-m", "config"]);
  const bin = fakeAgentBin(join(tempDir(), "bin"));
  const prompts = join(tempDir(), "prompts");
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, FAKE_PROMPT_DIR: prompts, ...extra };
  /** Run the fixture CLI with additional environment overrides for one invocation. */
  const devflowWith = (more: Record<string, string>, ...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, env: { ...env, ...more }, encoding: "utf8" });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  /** Execute the compiled CLI in the fixture and return captured output and exit status. */
  const devflow = (...args: string[]) => devflowWith({}, ...args);
  /** Load the task's persisted JSON so assertions can inspect transitions and counters. */
  const state = (id: string) => JSON.parse(readFileSync(join(root, ".devflow", "runs", id, "state.json"), "utf8"));
  /** Decode the CLI's newline-delimited stage reports for ordered assertions. */
  const lines = (out: string) => out.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  return { root, devflow, devflowWith, state, lines, prompts, env };
}

test("medium task: explore + design, stop for approval; approve binds plan; then implement, gates, verify, DONE", () => {
  const { root, devflow, state, lines, prompts } = setup();
  assert.equal(devflow("start", "t1", "Add mul").code, 0);
  const first = devflow("run", "t1");
  assert.equal(first.code, 0, first.out + first.err);
  const r1 = lines(first.out);
  assert.deepEqual(r1.slice(0, 2).map((r) => `${r.stage}:${r.outcome}`), ["explore:ok", "design:ok"]);
  assert.equal(r1.at(-1).next.reason, "awaiting_plan_approval");
  assert.deepEqual(state("t1").zone, ["src/**", "tests/**"]);

  assert.equal(devflow("approve", "t1").code, 0);
  assert.ok(state("t1").planDigest);

  const second = devflow("run", "t1");
  const r2 = lines(second.out);
  assert.deepEqual(r2.slice(0, 3).map((r) => `${r.stage}:${r.outcome}`), ["implement:ok", "gates:pass", "verify:pass"], second.out + second.err);
  assert.equal(state("t1").status, "DONE");

  const verdict = readFileSync(join(root, ".devflow", "runs", "t1", "verdict.md"), "utf8");
  assert.match(verdict, /design-visible: no/);
  assert.match(verdict, /reasoning-in-prompt: no/);
  assert.match(readFileSync(join(root, ".devflow", "runs", "t1", "logs", "verify-1.log"), "utf8"), /git-visible: no/);
  const verifyPrompt = readdirSync(prompts).find((f) => f.startsWith("VERIFY"));
  assert.ok(verifyPrompt);
  const vp = readFileSync(join(prompts, verifyPrompt!), "utf8");
  assert.match(vp, /tests\/mul\.test\.js checks mul/);
  assert.doesNotMatch(vp, /SECRET-DESIGN-REASONING/);
  assert.doesNotMatch(vp, /Threat model and verification context/);
  assert.match(readFileSync(join(root, "openspec", "changes", "t1", "tasks.md"), "utf8"), /- \[x\] 1\.1/);
});

test("only the verify prompt receives the committed threat model", () => {
  const { root, devflow, state, prompts } = setup();
  write(root, ".devflow/context.md", "THREAT-MODEL-MARKER\n");
  sh(root, "git", ["add", "-A"]);
  sh(root, "git", ["commit", "-q", "-m", "context"]);
  assert.equal(devflow("start", "t1c", "Add mul").code, 0);
  devflow("run", "t1c");
  devflow("approve", "t1c");
  devflow("run", "t1c");
  assert.equal(state("t1c").status, "DONE");
  /** Find the captured prompt for the requested stage. */
  const text = (stage: string) => {
    const f = readdirSync(prompts).find((n) => n.startsWith(stage));
    assert.ok(f, `no ${stage} prompt`);
    return readFileSync(join(prompts, f!), "utf8");
  };
  assert.match(text("VERIFY"), /## Threat model and verification context\s+THREAT-MODEL-MARKER/);
  assert.doesNotMatch(text("EXPLORE"), /THREAT-MODEL-MARKER/);
  assert.doesNotMatch(text("DESIGN"), /THREAT-MODEL-MARKER/);
});

test("Implement hits the limit without spending an attempt or running generate", () => {
  const { root, devflow, devflowWith, state, lines } = setup({}, (root, cfg) => {
    cfg.build = { generate: "node gen.cjs", outputs: ["marker.txt"] };
    write(root, "gen.cjs", 'require("node:fs").writeFileSync("marker.txt", "generated");');
  });
  assert.equal(devflow("start", "t1", "Add mul", "--tier", "small").code, 0);
  const run = devflowWith({ FAKE_LIMIT_ROLE: "IMPLEMENT", FAKE_LIMIT_OUTPUT: "codex" }, "run", "t1", "--once");
  assert.equal(run.code, 75, run.err);
  const [report] = lines(run.out);
  assert.equal(report.outcome, "paused");
  assert.equal(report.reason, "usage_limit");
  assert.equal(report.next.stage, "implement");
  assert.equal(state("t1").attempts.implement, 0);
  assert.equal(state("t1").status, "NEW");
  assert.equal(existsSync(join(root, "marker.txt")), false);
});

test("Limited verify removes its worktree and retries the same round", () => {
  const { root, devflow, devflowWith, state, lines } = setup();
  assert.equal(devflow("start", "t1", "Add mul").code, 0);
  assert.equal(devflow("run", "t1").code, 0);
  assert.equal(devflow("approve", "t1").code, 0);
  const run = devflowWith({ FAKE_LIMIT_ROLE: "VERIFY", FAKE_LIMIT_OUTPUT: "codex" }, "run", "t1");
  assert.equal(lines(run.out).at(-2).outcome, "paused");
  assert.equal(state("t1").history.some((h: { kind: string; stage?: string }) => h.kind === "complete" && h.stage === "verify"), false);
  assert.equal(sh(root, "git", ["worktree", "list"]).trim().split(/\r?\n/).length, 1);
  const retry = devflow("run", "t1");
  assert.equal(lines(retry.out)[0].details.round, 1);
  assert.equal(state("t1").status, "DONE");
});

/** Advance to verify and inject a cleanup failure, leaving the copy available until test teardown. */
async function pauseWithLeftoverCopy(t: import("node:test").TestContext) {
  const { root, devflow, state, env } = setup();
  assert.equal(devflow("start", "t1", "Add mul").code, 0);
  assert.equal(devflow("run", "t1").code, 0);
  assert.equal(devflow("approve", "t1").code, 0);
  assert.equal(devflow("run", "t1", "--once").code, 0);
  assert.equal(devflow("run", "t1", "--once").code, 0);
  const config = loadConfig(root);
  const attempts = state("t1").attempts.verify;
  const io = { now: () => new Date().toISOString(), env };
  let copy: string | undefined;
  t.after(() => {
    if (copy) assert.equal(removeDetached(root, copy), true);
  });
  const report = await runNextStage(root, config, "t1", {
    ...io,
    env: { ...env, FAKE_LIMIT_ROLE: "VERIFY", FAKE_LIMIT_OUTPUT: "codex" },
    removeCopy: (_root: string, path: string) => {
      copy = path;
      return false;
    },
  });
  assert.ok(copy && existsSync(copy));
  return { root, config, io, state, attempts, report, copy };
}

test("Verify copy cannot be removed during a pause and its path is only reported", async (t) => {
  const { root, state, attempts, report, copy } = await pauseWithLeftoverCopy(t);
  assert.equal(report?.outcome, "paused");
  assert.equal(report.reason, "usage_limit");
  assert.equal((report.details as { cleanup_failed?: string }).cleanup_failed, copy);
  assert.equal(state("t1").attempts.verify, attempts);
  assert.equal(state("t1").pause.stage, "verify");
  const rawState = readFileSync(join(root, ".devflow", "runs", "t1", "state.json"), "utf8");
  assert.ok(!rawState.includes(JSON.stringify(copy).slice(1, -1)));
  assert.doesNotMatch(rawState, /"pendingCleanup"|"cleaned"/);
});

test("Next run does not retry the removal and verifies round one in a fresh copy", async (t) => {
  const { root, config, io, report, copy } = await pauseWithLeftoverCopy(t);
  assert.equal(report?.outcome, "paused");
  const removed: string[] = [];
  const retry = await runNextStage(root, config, "t1", {
    ...io,
    removeCopy: (repo, path) => {
      removed.push(path);
      return removeDetached(repo, path);
    },
  });
  assert.equal(removed.length, 1);
  assert.notEqual(removed[0], copy);
  assert.ok(existsSync(copy));
  assert.equal(retry?.outcome, "pass");
  assert.equal((retry.details as { round: number }).round, 1);
});

test("Stops on a pause and the next run retries design at the same attempt", () => {
  const { devflow, devflowWith, lines, state } = setup();
  assert.equal(devflow("start", "t1", "Add mul").code, 0);
  const first = devflowWith({ FAKE_LIMIT_ROLE: "DESIGN", FAKE_LIMIT_OUTPUT: "codex" }, "run", "t1");
  assert.equal(first.code, 75, first.err);
  const reports = lines(first.out);
  assert.deepEqual(reports.slice(0, -1).map((r) => [r.stage, r.outcome]), [["explore", "ok"], ["design", "paused"]]);
  const final = reports.at(-1);
  assert.equal(final.outcome, "paused");
  assert.equal(final.next.stage, "design");
  assert.equal(final.pause.reset, "5:00 PM");
  assert.deepEqual(final.pause, final.next.pause);
  const attemptBeforePause = reports[0].next.attempt;
  assert.equal(attemptBeforePause, 1);
  assert.equal(final.next.attempt, attemptBeforePause);
  const retry = devflow("run", "t1");
  assert.equal(retry.code, 0, retry.err);
  const [design] = lines(retry.out);
  assert.equal(design.stage, "design");
  assert.equal(design.outcome, "ok");
  // A successful design records exactly one attempt and the loop stops for approval.
  assert.equal(state("t1").attempts.design, attemptBeforePause);
  assert.equal(design.next.pause, undefined);
});

/** Compute the prefixed SHA-256 value expected in a dirty-path snapshot. */
const contentHash = (content: string) => "sha256:" + createHash("sha256").update(content).digest("hex");

test("Human edit before implement is captured, including a deleted file", () => {
  const { root, devflow, state } = setup({}, (root) => {
    write(root, "README.md", "base");
    write(root, "docs/old.md", "old");
  });
  assert.equal(devflow("start", "t1", "Add mul", "--tier", "small").code, 0);
  write(root, "README.md", "human edit");
  unlinkSync(join(root, "docs/old.md"));
  write(root, "openspec/changes/t1/tasks.md", "task artifacts");
  assert.equal(devflow("run", "t1", "--once").code, 0);
  assert.deepEqual(state("t1").dirtyAtImplement.paths, { "README.md": contentHash("human edit"), "docs/old.md": null });
});

test("Retry keeps the first snapshot after a failed implement", () => {
  const { root, devflow, devflowWith, state } = setup();
  assert.equal(devflow("start", "t1", "Add mul", "--tier", "small").code, 0);
  write(root, "README.md", "human edit");
  const failed = devflowWith({ FAKE_FAIL_ROLE: "IMPLEMENT", FAKE_IMPLEMENT_TOUCH: "README.md=role edit" }, "run", "t1", "--once");
  assert.equal(failed.code, 1);
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "role edit");
  assert.equal(devflow("run", "t1", "--once").code, 0);
  assert.equal(state("t1").dirtyAtImplement.paths["README.md"], contentHash("human edit"));
});

test("Pause keeps the snapshot when implement retries", () => {
  const { root, devflow, devflowWith, state } = setup();
  assert.equal(devflow("start", "t1", "Add mul", "--tier", "small").code, 0);
  write(root, "README.md", "human edit");
  assert.equal(devflowWith({ FAKE_LIMIT_ROLE: "IMPLEMENT", FAKE_LIMIT_OUTPUT: "codex" }, "run", "t1", "--once").code, 75);
  write(root, "README.md", "later edit");
  assert.equal(devflow("run", "t1", "--once").code, 0);
  const task = state("t1");
  assert.equal(task.dirtyAtImplement.paths["README.md"], contentHash("human edit"));
  assert.equal(task.history.filter((h: { kind: string }) => h.kind === "dirty").length, 1);
});

test("Snapshot covers exempted paths and invalidates verify when they change", () => {
  const { root, devflow, state, lines } = setup();
  assert.equal(devflow("start", "t1", "Add mul").code, 0);
  assert.equal(devflow("run", "t1").code, 0);
  assert.equal(devflow("approve", "t1").code, 0);
  write(root, "README.md", "human edit");
  assert.equal(devflow("run", "t1", "--once").code, 0);
  const [gates] = lines(devflow("run", "t1", "--once").out);
  assert.equal(gates.outcome, "pass");
  assert.deepEqual(gates.details.results[0].warnings, ["preexisting_change:README.md"]);

  write(root, "README.md", "edit after gates");
  const [verify] = lines(devflow("run", "t1", "--once").out);
  assert.equal(verify.outcome, "snapshot_changed");
  assert.equal(verify.next.stage, "gates");
  assert.equal(state("t1").attempts.verify, 0);
});

test("--once runs exactly one stage", () => {
  const { devflow, lines } = setup();
  devflow("start", "t2", "Add mul");
  const r = lines(devflow("run", "t2", "--once").out);
  assert.deepEqual(r.filter((x) => x.stage).map((x) => x.stage), ["explore"]);
});

test("plan edited after approval sends the task back to approval", () => {
  const { root, devflow, state, lines } = setup();
  devflow("start", "t3", "Add mul");
  devflow("run", "t3");
  devflow("approve", "t3");
  write(root, "openspec/changes/t3/design.md", readFileSync(join(root, "openspec/changes/t3/design.md"), "utf8") + "\nchanged\n");
  const r = lines(devflow("run", "t3").out);
  assert.equal(r[0].outcome, "plan_changed");
  assert.equal(state("t3").status, "DESIGNED");
});

test("verifier edits are discarded; rework returns to implement", () => {
  const { root, devflow, state, lines } = setup({ FAKE_VERDICT: "REWORK", FAKE_VERIFY_EDIT: "1" });
  devflow("start", "t4", "Add mul");
  devflow("run", "t4");
  devflow("approve", "t4");
  assert.equal(lines(devflow("run", "t4", "--once").out)[0].stage, "implement");
  devflow("run", "t4", "--once");
  const v = lines(devflow("run", "t4", "--once").out);
  assert.deepEqual([v[0].stage, v[0].outcome], ["verify", "rework"]);
  const math = readFileSync(join(root, "src", "math.js"), "utf8");
  assert.match(math, /mul/);
  assert.doesNotMatch(math, /verifier was here/);
  assert.equal(state("t4").status, "PLAN_APPROVED");
});

/** Read captured implementation prompts in invocation order. */
const implementPrompts = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.startsWith("IMPLEMENT"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"));

/** Configure a fixture with a custom implement command and a trusted generation step. */
function generateProject(model: string, generate: string, timeout = 60) {
  const project = setup({}, (root, cfg) => {
    cfg.roles.implement = { runner: "command", model: "local", command: 'node implement.cjs "{prompt_file}"' };
    cfg.build = { generate: "node gen.cjs", outputs: ["plugins/**"] };
    cfg.test.timeout_seconds = timeout;
    write(root, "implement.cjs", model);
    write(root, "gen.cjs", generate);
  });
  const { devflow } = project;
  assert.equal(devflow("start", "gen", "Generate a bundle").code, 0);
  assert.equal(devflow("run", "gen").code, 0);
  assert.equal(devflow("approve", "gen").code, 0);
  return { ...project, run: () => project.lines(devflow("run", "gen", "--once").out)[0] };
}

test("generate runs once after the implementer in the project root using the base command", () => {
  const { root, run, state } = generateProject(
    "require('fs').appendFileSync('order.txt', 'implement\\n');",
    "require('fs').appendFileSync('order.txt', 'generate\\n' + process.cwd() + '\\n');",
  );
  const cfgPath = join(root, ".devflow", "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.build = { generate: "node alternate.cjs", outputs: ["alternate/**"] };
  writeFileSync(cfgPath, JSON.stringify(cfg));
  write(root, "alternate.cjs", "require('fs').writeFileSync('alternate.txt', 'wrong command');");

  const result = run();
  assert.deepEqual([result.stage, result.outcome], ["implement", "ok"]);
  const last = state("gen").history.at(-1);
  assert.deepEqual([last.kind, last.stage, last.outcome], ["complete", "implement", "ok"]);
  assert.equal(readFileSync(join(root, "order.txt"), "utf8"), "implement\n" + "generate\n" + root + "\n");
  assert.equal(existsSync(join(root, "alternate.txt")), false);
  const prompt = readFileSync(join(root, ".devflow", "runs", "gen", "logs", "implement-1.prompt.txt"), "utf8");
  assert.match(prompt, /plugins\/\*\*.*node gen\.cjs/);
  assert.match(prompt, /default.*approved plan/i);
  // The implementer may refresh generated outputs itself, so they are in its write scope.
  assert.match(prompt, /Outputs: you may write [^\n]*plugins\/\*\*/);
  assert.doesNotMatch(prompt, /alternate\/\*\*/);
});

test("generate is skipped after failed, blocked, and plan-conflict implement runs", async (t) => {
  const cases = [
    ["process.exit(3);", "fail"],
    ["console.log('BLOCKED: missing tool');", "blocked"],
    ["console.log('PLAN CONFLICT: missing scope');", "plan_conflict"],
  ];
  for (const [model, outcome] of cases) {
    await t.test(outcome!, () => {
      const { root, run } = generateProject(model!, "require('fs').writeFileSync('generated.txt', 'unexpected');");
      assert.equal(run().outcome, outcome);
      assert.equal(existsSync(join(root, "generated.txt")), false);
    });
  }
});

test("generate failure spends an implement attempt and feeds the log to one prompt", () => {
  const { root, run, state } = generateProject(`
    const { existsSync } = require('node:fs');
    if (existsSync('.devflow/runs/gen/generate-failure.md')) process.exit(1);
  `,
    "if (!require('fs').existsSync('src/ready')) { console.log('bundle error'); process.exit(1); }",
  );
  const dir = join(root, ".devflow", "runs", "gen");
  const feedback = join(dir, "generate-failure.md");
  const failed = run();
  assert.deepEqual([failed.outcome, failed.reason, failed.details.exitCode, failed.details.timedOut], ["fail", "generate_failed", 1, false]);
  assert.equal(state("gen").attempts.implement, 1);
  assert.match(readFileSync(feedback, "utf8"), /node gen\.cjs[\s\S]*exit 1[\s\S]*Log tail:[\s\S]*bundle error/);

  write(root, "src/ready", "");
  assert.equal(run().outcome, "ok");
  assert.equal(existsSync(feedback), false);
  assert.match(readFileSync(join(dir, "logs", "implement-2.prompt.txt"), "utf8"), /Generate step failure[\s\S]*bundle error/);
  write(root, "tests/fail.test.js", "throw new Error('retry the implementation');");
  assert.equal(run().outcome, "fail");
  assert.equal(run().outcome, "ok");
  assert.doesNotMatch(readFileSync(join(dir, "logs", "implement-3.prompt.txt"), "utf8"), /bundle error/);
});

test("generate uses the test timeout", () => {
  const { root, run } = generateProject("", "setTimeout(() => {}, 2000);", 1);
  const result = run();
  assert.deepEqual([result.outcome, result.reason, result.details.timedOut], ["fail", "generate_failed", true]);
  assert.match(readFileSync(join(root, ".devflow", "runs", "gen", "generate-failure.md"), "utf8"), /timed out/);
});

test("implement and small allow the trusted generate command in the shell scope", async (t) => {
  for (const tier of ["medium", "small"]) {
    await t.test(tier, () => {
      const { root, devflow, lines } = setup({}, (root, cfg) => {
        cfg.roles[tier === "small" ? "small" : "implement"] = { runner: "claude", model: "sonnet" };
        cfg.build = { generate: "node gen.cjs", outputs: ["plugins/**"] };
        write(root, "gen.cjs", "");
      });
      assert.equal(devflow("start", "scope", "Generate a bundle", "--tier", tier).code, 0);
      if (tier === "medium") {
        assert.equal(devflow("run", "scope").code, 0);
        assert.equal(devflow("approve", "scope").code, 0);
      }
      assert.equal(lines(devflow("run", "scope", "--once").out)[0].outcome, "ok");
      const role = tier === "small" ? "small" : "implement";
      const scope = JSON.parse(readFileSync(join(root, ".devflow", "runs", "scope", "logs", `${role}-1.scope.json`), "utf8"));
      assert.deepEqual(scope.bash, ["node check.js", "node gen.cjs"]);
      // Generated outputs are writable so the implementer can refresh them before running the tests.
      assert.ok(scope.write.includes("plugins/**"));
    });
  }
});

test("implement and verify scopes follow the trusted test.focused only", async (t) => {
  const focusedTemplate = "node check.js {files}";
  const cases = [
    { name: "committed focused", committed: true, working: true },
    { name: "working-copy focused is ignored", committed: false, working: true },
    { name: "focused not configured", committed: false, working: false },
  ];
  for (const c of cases) {
    await t.test(c.name, () => {
      const { root, devflow, lines, prompts } = setup({}, (_root, cfg) => {
        cfg.roles.implement = { runner: "claude", model: "sonnet" };
        cfg.roles.verify = { runner: "claude", model: "opus" };
        if (c.committed) cfg.test.focused = focusedTemplate;
      });
      if (c.working && !c.committed) {
        const path = join(root, ".devflow", "config.json");
        const cfg = JSON.parse(readFileSync(path, "utf8"));
        cfg.test.focused = focusedTemplate;
        writeFileSync(path, JSON.stringify(cfg, null, 2));
      }
      assert.equal(devflow("start", "foc", "Focused scope").code, 0);
      assert.equal(devflow("run", "foc").code, 0);
      assert.equal(devflow("approve", "foc").code, 0);
      const stages = lines(devflow("run", "foc").out).map((r) => `${r.stage}:${r.outcome}`);
      assert.deepEqual(stages.slice(0, 3), ["implement:ok", "gates:pass", "verify:pass"]);
      const logs = join(root, ".devflow", "runs", "foc", "logs");
      const scope = (role: string) => JSON.parse(readFileSync(join(logs, `${role}-1.scope.json`), "utf8"));
      const test = JSON.parse(readFileSync(join(root, ".devflow", "config.json"), "utf8")).test;
      const expected = c.committed ? { template: focusedTemplate, paths: test.paths } : undefined;
      assert.deepEqual(scope("implement").focused, expected);
      assert.deepEqual(scope("verify").focused, expected);
      assert.deepEqual(scope("implement").bash, c.committed ? [] : [test.command]);
      assert.deepEqual(scope("verify").bash, c.committed ? [] : [test.command]);
      const text = (stage: string) => readFileSync(join(prompts, readdirSync(prompts).find((f) => f.startsWith(stage))!), "utf8");
      assert.equal(text("IMPLEMENT").includes(`\`${focusedTemplate}\``), c.committed);
      assert.equal(text("VERIFY").includes(`\`${focusedTemplate}\``), c.committed);
    });
  }
});

test("verify regenerates its copy before the verifier and stops on generation failure", async (t) => {
  for (const fail of [false, true]) {
    await t.test(fail ? "generate failure" : "fresh bundle", () => {
      const { root, devflow, lines, state } = setup({}, (root, cfg) => {
        cfg.build = { generate: "node gen.cjs", outputs: ["out/**"] };
        cfg.test.setup = "node setup.cjs";
        cfg.roles.verify = { runner: "command", model: "local", command: "node verify.cjs" };
        write(root, "out/bundle.txt", readFileSync(join(root, "src", "math.js"), "utf8"));
        write(root, "setup.cjs", "require('fs').writeFileSync('setup-ready', '');");
        write(root, "gen.cjs", [
          "const fs = require('fs');",
          "if (!fs.existsSync('.devflow') && (" + fail + " || !fs.existsSync('setup-ready'))) process.exit(1);",
          "fs.copyFileSync('src/math.js', 'out/bundle.txt');",
        ].join("\n"));
        write(root, "verify.cjs", [
          "const fs = require('fs');",
          "console.log('verifier ran');",
          "if (fs.readFileSync('out/bundle.txt', 'utf8') === fs.readFileSync('src/math.js', 'utf8')) {",
          "  fs.writeFileSync('.devflow-verdict.md', 'VERDICT: PASS\\n');",
          "}",
        ].join("\n"));
      });

      assert.equal(devflow("start", "verifygen", "Regenerate before verify").code, 0);
      assert.equal(devflow("run", "verifygen").code, 0);
      assert.equal(devflow("approve", "verifygen").code, 0);
      const baseBundle = readFileSync(join(root, "out", "bundle.txt"), "utf8");
      /** Run the fixture stage and return its first report. */
      const run = () => lines(devflow("run", "verifygen", "--once").out)[0];
      assert.equal(run().outcome, "ok");
      write(root, "out/bundle.txt", baseBundle);
      assert.equal(run().outcome, "pass");
      const report = run();
      assert.deepEqual([report.stage, report.outcome, report.reason], ["verify", fail ? "human" : "pass", fail ? "verify_generate_failed" : undefined]);
      assert.equal(state("verifygen").lastVerdict.outcome, fail ? "human" : "pass");
      const logs = join(root, ".devflow", "runs", "verifygen", "logs");
      const cwd = readFileSync(join(logs, "verify_generate-1.log"), "utf8").match(/^# cwd: (.+)$/m)?.[1];
      assert.ok(cwd);
      assert.notEqual(cwd, root);
      assert.equal(existsSync(cwd), false);
      const verifierLog = join(logs, "verify-1.log");
      if (fail) assert.equal(existsSync(verifierLog), false);
      else assert.match(readFileSync(verifierLog, "utf8"), /verifier ran/);
      assert.equal(readFileSync(join(root, "out", "bundle.txt"), "utf8"), baseBundle);
    });
  }
});

test("after REWORK the next implement prompt carries the verify verdict", () => {
  const { devflow, lines, prompts } = setup({ FAKE_VERDICT: "REWORK" });
  devflow("start", "t4v", "Add mul");
  devflow("run", "t4v");
  devflow("approve", "t4v");
  devflow("run", "t4v", "--once");
  devflow("run", "t4v", "--once");
  assert.equal(lines(devflow("run", "t4v", "--once").out)[0].outcome, "rework");
  assert.equal(lines(devflow("run", "t4v", "--once").out)[0].stage, "implement");
  const [first, second] = implementPrompts(prompts);
  assert.doesNotMatch(first!, /Verify verdict on the previous attempt/);
  assert.match(second!, /## Verify verdict on the previous attempt[^\n]*\n\nVERDICT: REWORK\n\ndesign-visible: no/);
});

test("after a gate failure the next implement prompt carries the gate and its log tail", () => {
  const { root, devflow, lines, prompts } = setup();
  devflow("start", "t4g", "Add mul");
  devflow("run", "t4g");
  devflow("approve", "t4g");
  devflow("run", "t4g", "--once");
  write(root, "tests/broken.test.js", "throw new Error('GATE-FAIL-MARKER');\n");
  const g = lines(devflow("run", "t4g", "--once").out)[0];
  assert.deepEqual([g.stage, g.outcome], ["gates", "fail"]);
  devflow("run", "t4g", "--once");
  const [first, second] = implementPrompts(prompts);
  assert.doesNotMatch(first!, /Gate failure on the previous attempt/);
  assert.match(second!, /## Gate failure on the previous attempt[\s\S]*Gate tests: fail[\s\S]*GATE-FAIL-MARKER/);
  // Once the gates pass, the old failure is no longer offered.
  write(root, "tests/broken.test.js", "\n");
  assert.equal(lines(devflow("run", "t4g", "--once").out)[0].outcome, "pass");
  assert.equal(existsSync(join(root, ".devflow", "runs", "t4g", "gates-failure.md")), false);
});

test("implement can send a wrong plan back to design as a new revision; the second time a human decides", () => {
  const { devflow, state, lines, prompts } = setup({ FAKE_PLAN_CONFLICT: "decision 4 keeps line breaks, the finding needs folding" });
  devflow("start", "tpc", "Add mul");
  devflow("run", "tpc");
  devflow("approve", "tpc");
  const r = lines(devflow("run", "tpc", "--once").out)[0];
  assert.deepEqual([r.stage, r.outcome, r.reason], ["implement", "plan_conflict", "decision 4 keeps line breaks, the finding needs folding"]);
  const s = state("tpc");
  assert.deepEqual([s.status, s.planRevision, s.planDigest], ["EXPLORED", 2, undefined]);
  assert.doesNotMatch(implementPrompts(prompts)[0]!, /^PLAN CONFLICT:/m);
  const d = lines(devflow("run", "tpc", "--once").out)[0];
  assert.deepEqual([d.stage, d.outcome], ["design", "ok"]);
  const designs = readdirSync(prompts).filter((f) => f.startsWith("DESIGN")).sort();
  assert.match(readFileSync(join(prompts, designs.at(-1)!), "utf8"), /implementer: decision 4 keeps line breaks/);
  assert.equal(state("tpc").status, "DESIGNED");
  devflow("approve", "tpc");
  devflow("run", "tpc", "--once");
  assert.deepEqual([state("tpc").status, state("tpc").humanReason], ["HUMAN", "plan_conflicts_limit"]);
});

test("a verdict given in claude's answer instead of the file is still read", () => {
  const { root, devflow, state, lines } = setup({ FAKE_VERDICT_IN_ANSWER: "1" });
  const cfgPath = join(root, ".devflow", "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.roles.verify = { runner: "claude", model: "sonnet" };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  sh(root, "git", ["commit", "-qam", "verify on claude"]);
  devflow("start", "tva", "Add mul");
  devflow("run", "tva");
  devflow("approve", "tva");
  const out = lines(devflow("run", "tva").out);
  assert.deepEqual(out.slice(0, 3).map((x) => `${x.stage}:${x.outcome}`), ["implement:ok", "gates:pass", "verify:pass"]);
  assert.equal(state("tva").status, "DONE");
  assert.match(readFileSync(join(root, ".devflow", "runs", "tva", "verdict.md"), "utf8"), /^VERDICT: PASS\n\ndesign-visible: no/);
});

test("a verify round that produced no verdict does not lose the earlier findings", () => {
  const { devflow, devflowWith, state, lines, prompts } = setup({ FAKE_VERDICT: "REWORK" });
  devflow("start", "tpv", "Add mul");
  devflow("run", "tpv");
  devflow("approve", "tpv");
  devflow("run", "tpv", "--once");
  devflow("run", "tpv", "--once");
  assert.equal(lines(devflow("run", "tpv", "--once").out)[0].outcome, "rework");
  devflow("run", "tpv", "--once");
  devflow("run", "tpv", "--once");
  const failed = lines(devflowWith({ FAKE_FAIL_ROLE: "VERIFY" }, "run", "tpv", "--once").out)[0];
  assert.deepEqual([failed.stage, failed.outcome], ["verify", "human"]);
  assert.equal(devflow("approve", "tpv", "--resume").code, 0);
  devflow("run", "tpv", "--once");
  devflow("run", "tpv", "--once");
  const last = lines(devflowWith({ FAKE_VERDICT: "PASS" }, "run", "tpv", "--once").out)[0];
  assert.deepEqual([last.stage, last.outcome, last.details.round], ["verify", "pass", 3]);
  assert.equal(state("tpv").status, "DONE");
  const verifies = readdirSync(prompts).filter((f) => f.startsWith("VERIFY")).sort();
  const round3 = readFileSync(join(prompts, verifies.at(-1)!), "utf8");
  assert.match(round3, /This is round 3/);
  assert.match(round3, /VERDICT: REWORK\n\ndesign-visible: no/);
});

test("a blocked implementer stops the task for a human without spending an attempt", () => {
  const { devflow, devflowWith, state, lines, prompts } = setup();
  devflow("start", "tbl", "Add mul");
  devflow("run", "tbl");
  devflow("approve", "tbl");
  const r = lines(devflowWith({ FAKE_BLOCKED: "cannot read the guidance file" }, "run", "tbl").out)[0];
  assert.deepEqual([r.stage, r.outcome, r.reason], ["implement", "blocked", "cannot read the guidance file"]);
  const s = state("tbl");
  assert.deepEqual([s.status, s.humanReason, s.attempts.implement], ["HUMAN", "role_blocked", 0]);
  assert.doesNotMatch(implementPrompts(prompts)[0]!, /^BLOCKED:/m);
  assert.equal(devflow("approve", "tbl", "--resume").code, 0);
  assert.equal(lines(devflow("run", "tbl", "--once").out)[0].outcome, "ok");
});

test("rejecting a plan gives the new revision fresh implement attempts", () => {
  const { devflow, devflowWith, state } = setup();
  devflow("start", "tra", "Add mul");
  devflow("run", "tra");
  devflow("approve", "tra");
  devflowWith({ FAKE_PLAN_CONFLICT: "needs a different design" }, "run", "tra", "--once");
  devflow("run", "tra", "--once");
  assert.equal(state("tra").status, "DESIGNED");
  devflow("approve", "tra");
  devflow("run", "tra", "--once");
  assert.equal(state("tra").attempts.implement, 1);
});

test("an edit between gates and verify sends the task back to gates", () => {
  const { root, devflow, state, lines } = setup();
  devflow("start", "t5", "Add mul");
  devflow("run", "t5");
  devflow("approve", "t5");
  devflow("run", "t5", "--once");
  devflow("run", "t5", "--once");
  write(root, "src/math.js", "exports.add = (a, b) => a + b;\nexports.mul = (a, b) => b * a;\n");
  const r = lines(devflow("run", "t5", "--once").out);
  assert.deepEqual([r[0].stage, r[0].outcome], ["invalidate", "snapshot_changed"]);
  assert.equal(state("t5").status, "IMPLEMENTED");
  assert.equal(state("t5").counters.staleEvidence, 1);
});

test("a failing role stops the loop with fail", () => {
  const { devflow, lines } = setup({ FAKE_FAIL_ROLE: "EXPLORE" });
  devflow("start", "t6", "Add mul");
  const r = devflow("run", "t6");
  assert.equal(r.code, 1);
  assert.equal(lines(r.out)[0].outcome, "fail");
});

test("a rejected plan goes back to design as a new revision; unchanged files are flagged, not failed", () => {
  const { root, devflow, state, lines, prompts } = setup();
  devflow("start", "t8", "Add mul");
  devflow("run", "t8");
  assert.equal(devflow("approve", "t8", "--reject", "Cover negative numbers").code, 0);
  assert.equal(state("t8").status, "EXPLORED");
  assert.equal(state("t8").planRevision, 2);
  const r = lines(devflow("run", "t8", "--once").out);
  assert.deepEqual([r[0].stage, r[0].outcome, r[0].reason, r[0].details.revision], ["design", "ok", "plan_files_unchanged", 2]);
  assert.equal(devflow("approve", "t8").code, 0);
  assert.ok(state("t8").planDigest);
  const designPrompts = readdirSync(prompts).filter((f) => f.startsWith("DESIGN"));
  const last = readFileSync(join(prompts, designPrompts.sort().at(-1)!), "utf8");
  assert.match(last, /Cover negative numbers/);
  write(root, "openspec/changes/t8/tasks.md", "- [ ] 1.1 Changed by hand\n");
});

/** Approve revision 4 of a medium task whose fake verifier always asks for rework. */
function approvedReworkPlan() {
  const fixture = setup({ FAKE_VERDICT: "REWORK\n\nSecond review: cover signed operands." });
  const { root, devflow, state } = fixture;
  const id = "escalated";
  assert.equal(devflow("start", id, "Add mul", "--tier", "medium").code, 0);
  for (let revision = 1; revision <= 4; revision++) {
    const result = devflow("run", id);
    assert.equal(result.code, 0, result.out + result.err);
    assert.equal(state(id).planRevision ?? 1, revision);
    if (revision < 4) assert.equal(devflow("approve", id, "--reject", "Cover negative numbers").code, 0);
  }
  // Let the fake designer refresh the root files while retaining the exact same delta.
  for (const file of ["proposal.md", "design.md", "tasks.md"]) {
    const path = join(root, "openspec", "changes", id, file);
    writeFileSync(path, readFileSync(path, "utf8") + "\n");
  }
  assert.equal(devflow("approve", id).code, 0);
  return { ...fixture, id };
}

/** Record one fake rework round, leaving the next round to the caller. */
function firstRework({ devflowWith, id, lines }: ReturnType<typeof approvedReworkPlan>) {
  for (const stage of ["implement", "gates", "verify"]) {
    const result = devflowWith({ FAKE_VERDICT: "REWORK\n\nFirst review: cover zero." }, "run", id, "--once");
    assert.equal(result.code, 0, result.out + result.err);
    assert.equal(lines(result.out)[0]?.stage, stage);
  }
}

/** Check the latest saved designer prompt for the escalation request and its evidence. */
function assertEscalationPrompt(prompts: string) {
  const last = readdirSync(prompts).filter(f => f.startsWith("DESIGN-")).sort().at(-1)!;
  const prompt = readFileSync(join(prompts, last), "utf8");
  assert.match(prompt, /Automatic escalation medium → complex \(rework_repeated\)/);
  assert.match(prompt, /## Latest revision request \(binding scope\)/);
  assert.match(prompt, /Current plan files \(revise them\)/);
  for (const file of ["proposal.md", "design.md", "tasks.md", "specs/math/spec.md"]) {
    assert.ok(prompt.includes(`## openspec/changes/escalated/${file}\n`), file);
  }
  assert.match(prompt, /VERDICT: REWORK\s+Second review: cover signed operands\./);
  assert.doesNotMatch(prompt, /First review: cover zero/);
}

test("an escalated redesign retains its delta and awaits approval of revision 5", () => {
  const fixture = approvedReworkPlan();
  const { root, id, devflow, state, lines, prompts } = fixture;
  const delta = join(root, "openspec", "changes", id, "specs", "math", "spec.md");
  const before = createHash("sha256").update(readFileSync(delta)).digest("hex");
  firstRework(fixture);
  const result = devflow("run", id);
  const reports = lines(result.out);
  const design = reports.find(r => r.stage === "design");
  assert.equal(design?.outcome, "ok", JSON.stringify(design ?? reports));
  assert.doesNotMatch(result.out, /stale_delta/);
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(design.details.revision, 5);
  const current = state(id);
  assert.deepEqual([current.tier, current.planRevision, current.status], ["complex", 5, "DESIGNED"]);
  assert.deepEqual(current.history.filter((h: { stage?: string }) => h.stage === "verify").map(
    (h: { outcome: string }) => h.outcome
  ), ["rework", "rework"]);
  assert.equal(reports.at(-1).next.reason, "awaiting_plan_approval");
  assert.deepEqual(current.history.filter((h: { kind: string }) => h.kind === "escalate").map(
    (h: { reason: string; results: string }) => [h.reason, h.results]
  ), [["rework_repeated", "revision 5"]]);
  assert.equal(createHash("sha256").update(readFileSync(delta)).digest("hex"), before);
  assertEscalationPrompt(prompts);
});

test("retrying a failed escalated design keeps revision 5 and its escalation context", () => {
  const fixture = approvedReworkPlan();
  const { id, devflow, devflowWith, state, lines, prompts } = fixture;
  firstRework(fixture);
  const failed = devflowWith({ FAKE_FAIL_ROLE: "DESIGN" }, "run", id);
  const design = lines(failed.out).find(r => r.stage === "design");
  assert.deepEqual([design?.outcome, design?.reason], ["fail", "run_failed"], failed.out + failed.err);
  assert.deepEqual([state(id).status, state(id).planRevision], ["EXPLORED", 5]);
  const retry = devflow("run", id);
  const report = lines(retry.out).find(r => r.stage === "design");
  assert.deepEqual([report?.outcome, report?.details.revision], ["ok", 5], retry.out + retry.err);
  assert.deepEqual([state(id).status, state(id).planRevision], ["DESIGNED", 5]);
  assertEscalationPrompt(prompts);
});

test("CLI verify rework gives redesign its recorded reason without the previous verdict", () => {
  const fixture = approvedReworkPlan();
  const { id, devflow, state, prompts } = fixture;
  firstRework(fixture);
  for (const stage of ["implement", "gates"]) {
    const result = devflow("run", id, "--once");
    assert.equal(result.code, 0, result.out + result.err);
    assert.match(result.out, new RegExp(`"stage":"${stage}"`));
  }
  const rework = devflow("complete", id, "verify", "rework", "--override", "Manual review needs signed operands");
  assert.equal(rework.code, 0, rework.out + rework.err);
  const result = devflow("run", id);
  assert.equal(result.code, 0, result.out + result.err);
  assert.deepEqual([state(id).status, state(id).planRevision], ["DESIGNED", 5]);
  const last = readdirSync(prompts).filter(f => f.startsWith("DESIGN-")).sort().at(-1)!;
  const prompt = readFileSync(join(prompts, last), "utf8");
  assert.match(prompt, /verify: rework \(Manual review needs signed operands\)/);
  assert.doesNotMatch(prompt, /First review: cover zero|VERDICT:/);
});

test("CLI gate failures before verify give redesign the triggering outcome and reason", () => {
  const { root, id, devflow, state, lines, prompts } = approvedReworkPlan();
  for (const reason of ["First manual failure", "Second manual failure"]) {
    assert.equal(devflow("complete", id, "implement", "ok").code, 0);
    const failure = devflow("complete", id, "gates", "fail", "--override", reason);
    assert.equal(failure.code, 0, failure.out + failure.err);
  }
  assert.deepEqual([state(id).status, state(id).planRevision], ["EXPLORED", 5]);
  writeFileSync(join(root, ".devflow", "runs", id, "gates-failure.md"), "Unrelated old gate report");
  const result = devflow("run", id);
  assert.equal(result.code, 0, result.out + result.err);
  const reports = lines(result.out);
  assert.equal(reports.find(r => r.stage === "design")?.outcome, "ok");
  assert.equal(reports.at(-1).next.reason, "awaiting_plan_approval");
  const last = readdirSync(prompts).filter(f => f.startsWith("DESIGN-")).sort().at(-1)!;
  const prompt = readFileSync(join(prompts, last), "utf8");
  assert.match(prompt, /gates_failed_repeatedly/);
  assert.match(prompt, /gates: fail \(Second manual failure\)/);
  assert.doesNotMatch(prompt, /First manual failure|Unrelated old gate report|VERDICT:/);
});

test("a role whose CLI cannot be launched is a failed stage, not a crash", () => {
  const { root, devflow, lines } = setup();
  const cfgPath = join(root, ".devflow", "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.roles.explore = { runner: "command", model: "x", command: "definitely-not-installed-cli {model}" };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  devflow("start", "t9", "Add mul");
  const r = devflow("run", "t9");
  assert.equal(r.code, 1, r.err);
  const first = lines(r.out)[0];
  assert.deepEqual([first.stage, first.outcome], ["explore", "fail"]);
  assert.equal(first.details.error, "cli_not_found");
});

test("manual verify pass needs an override", () => {
  const { devflow } = setup();
  devflow("start", "t7", "x", "--tier", "small");
  const r = devflow("complete", "t7", "verify", "pass", "--json");
  assert.equal(JSON.parse(r.err).error.reason, "verify_needs_run");
});


test("node revision changes only the requested OpenSpec checkbox and preserves the plan context", () => {
  const { root, devflow, prompts } = setup();
  devflow("start", "nodes", "Add mul");
  devflow("run", "nodes");
  const folder = join(root, "openspec/changes/nodes");
  const path = join(folder, "tasks.md");
  const original = readFileSync(path, "utf8") + "\n- [x] 1.2 Keep this completed sibling.\n";
  writeFileSync(path, original);
  const spec = readFileSync(join(folder, "specs/math/spec.md"), "utf8");
  assert.equal(devflow("approve", "nodes", "--revision", "1", "--node", "9.9", "--reject", "Change test").code, 1);
  const reject = devflow("approve", "nodes", "--revision", "1", "--node", "1.1", "--reject", "Use a negative input");
  assert.equal(reject.code, 0, reject.err);
  const run = devflow("run", "nodes", "--once");
  assert.equal(run.code, 0, run.out + run.err);
  assert.equal(readFileSync(path, "utf8"), original.replace("Add mul and its test; verify with node check.js", "Check negative input with node check.js"));
  assert.equal(readFileSync(join(folder, "specs/math/spec.md"), "utf8"), spec);
  const design = readdirSync(prompts).filter(f => f.startsWith("DESIGN")).sort().at(-1)!;
  assert.match(readFileSync(join(prompts, design), "utf8"), /Keep this completed sibling/);
  assert.equal(devflow("approve", "nodes", "--revision", "2").code, 0);
});

test("different plan conflicts do not exhaust each other's budget and HUMAN accepts an explicit revision", () => {
  const { devflow, devflowWith, state } = setup();
  devflow("start", "conflicts", "Add mul");
  devflow("run", "conflicts");
  for (const reason of ["[1.1/scope] missing path", "[1.1/test] missing assertion", "[1.1/test] assertion still missing"]) {
    assert.equal(devflow("approve", "conflicts").code, 0);
    devflowWith({ FAKE_PLAN_CONFLICT: reason }, "run", "conflicts", "--once");
    if (reason.includes("still")) break;
    assert.equal(state("conflicts").status, "EXPLORED");
    assert.equal(devflow("run", "conflicts", "--once").code, 0);
  }
  assert.equal(state("conflicts").humanReason, "plan_conflicts_limit");
  assert.equal(devflow("approve", "conflicts", "--revision", "2", "--reject", "Change the plan").code, 1);
  assert.equal(devflow("approve", "conflicts", "--revision", "3", "--reject", "Change the plan").code, 0);
  assert.equal(state("conflicts").planRevision, 4);
});

test("approved finding decisions replace obsolete instructions while a new verify round remains actionable", () => {
  const { root, devflow, devflowWith, prompts } = setup();
  devflow("start", "decisions", "Add mul");
  devflow("run", "decisions");
  devflow("approve", "decisions");
  devflowWith({ FAKE_VERDICT: "REWORK" }, "run", "decisions", "--once");
  devflow("run", "decisions", "--once");
  devflowWith({ FAKE_VERDICT: "REWORK" }, "run", "decisions", "--once");
  const dir = join(root, ".devflow/runs/decisions");
  const s = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  assert.equal(s.lastVerdict.outcome, "rework");
  writeFileSync(join(dir, "verdict.md"), "VERDICT: REWORK\n1. **High** fix the arithmetic\n2. **High** OBSOLETE-RAW-INSTRUCTION\n");
  devflowWith({ FAKE_PLAN_CONFLICT: "plan is wrong" }, "run", "decisions", "--once");
  devflow("run", "decisions", "--once");
  const path = join(root, "openspec/changes/decisions/tasks.md");
  const tasks = readFileSync(path, "utf8");
  const decisions = "\n## Review decisions (round 1)\n\n- F1 | fix | 1.1 | Check negative inputs\n- F2 | defer | - | Outside this change\n";
  writeFileSync(path, tasks + decisions.replace("1.1 | Check", "9.9 | Check"));
  assert.equal(devflow("approve", "decisions").code, 1);
  writeFileSync(path, tasks + decisions);
  assert.equal(devflow("approve", "decisions").code, 0);
  const impl = devflow("run", "decisions", "--once");
  assert.equal(impl.code, 0, impl.err);
  const prompt = implementPrompts(prompts).at(-1)!;
  assert.match(prompt, /Check negative inputs/);
  assert.match(prompt, /fix the arithmetic/);
  assert.doesNotMatch(prompt, /OBSOLETE-RAW-INSTRUCTION/);
  devflow("run", "decisions", "--once");
  devflowWith({ FAKE_VERDICT: "REWORK" }, "run", "decisions", "--once");
  const verifyPrompt = readdirSync(prompts).filter(f => f.startsWith("VERIFY")).sort().at(-1)!;
  assert.doesNotMatch(readFileSync(join(prompts, verifyPrompt), "utf8"), /OBSOLETE-RAW-INSTRUCTION/);
});


test("plan node pool is accessible and an implementer's targeted conflict replans only its node", () => {
  const { root, devflow, devflowWith, state } = setup();
  devflow("start", "pool", "Add mul");
  devflow("run", "pool");
  const file = join(root, "openspec/changes/pool/tasks.md");
  const original = readFileSync(file, "utf8") + "\n- [x] 1.2 Keep sibling\n";
  writeFileSync(file, original);
  const pool = devflow("nodes", "pool", "--json");
  assert.equal(pool.code, 0, pool.err);
  assert.deepEqual(JSON.parse(pool.out).nodes.map((n: any) => [n.id, n.done]), [["1.1", false], ["1.2", true]]);
  assert.equal(devflow("approve", "pool").code, 0);
  devflowWith({ FAKE_PLAN_CONFLICT: "[1.1/test] use negative input" }, "run", "pool", "--once");
  assert.equal(state("pool").history.at(-1).node, "1.1");
  assert.equal(devflow("run", "pool", "--once").code, 0);
  assert.equal(readFileSync(file, "utf8"), original.replace("Add mul and its test; verify with node check.js", "Check negative input with node check.js"));
});


test("a revised plan with no dispositions keeps the untriaged review visible", () => {
  const { devflow, devflowWith, prompts } = setup();
  devflow("start", "legacy", "Add mul");
  devflow("run", "legacy");
  devflow("approve", "legacy");
  for (let n = 0; n < 3; n++) devflowWith({ FAKE_VERDICT: "REWORK" }, "run", "legacy", "--once");
  devflowWith({ FAKE_PLAN_CONFLICT: "shared requirement" }, "run", "legacy", "--once");
  devflow("run", "legacy", "--once");
  devflow("approve", "legacy");
  devflow("run", "legacy", "--once");
  assert.match(implementPrompts(prompts).at(-1)!, /Untriaged review[\s\S]*VERDICT: REWORK/);
});
