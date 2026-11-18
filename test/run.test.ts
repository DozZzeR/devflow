import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeAgentBin } from "./fake.js";
import { gitProject, sh, write } from "./gitrepo.js";
import { tempDir } from "./helpers.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

function setup(extra: Record<string, string> = {}) {
  const { root } = gitProject();
  const cfgPath = join(root, ".devflow", "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.openspec = { cli: "off" };
  cfg.runners = { env: { pass: ["FAKE_VERDICT", "FAKE_VERIFY_EDIT", "FAKE_PROMPT_DIR", "FAKE_FAIL_ROLE"] } };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  sh(root, "git", ["add", "-A"]);
  sh(root, "git", ["commit", "-q", "-m", "config"]);
  const bin = fakeAgentBin(join(tempDir(), "bin"));
  const prompts = join(tempDir(), "prompts");
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, FAKE_PROMPT_DIR: prompts, ...extra };
  const devflow = (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: "utf8" });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  const state = (id: string) => JSON.parse(readFileSync(join(root, ".devflow", "runs", id, "state.json"), "utf8"));
  const lines = (out: string) => out.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  return { root, devflow, state, lines, prompts };
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
  const verifyPrompt = readdirSync(prompts).find((f) => f.startsWith("VERIFY"));
  assert.ok(verifyPrompt);
  const vp = readFileSync(join(prompts, verifyPrompt!), "utf8");
  assert.match(vp, /tests\/mul\.test\.js checks mul/);
  assert.doesNotMatch(vp, /SECRET-DESIGN-REASONING/);
  assert.match(readFileSync(join(root, "openspec", "changes", "t1", "tasks.md"), "utf8"), /- \[x\] 1\.1/);
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

test("a rejected plan goes back to design; a revision that changes nothing fails", () => {
  const { root, devflow, state, lines, prompts } = setup();
  devflow("start", "t8", "Add mul");
  devflow("run", "t8");
  assert.equal(devflow("approve", "t8", "--reject", "Cover negative numbers").code, 0);
  assert.equal(state("t8").status, "EXPLORED");
  const r = lines(devflow("run", "t8", "--once").out);
  assert.deepEqual([r[0].stage, r[0].outcome, r[0].reason], ["design", "fail", "plan_unchanged"]);
  const designPrompts = readdirSync(prompts).filter((f) => f.startsWith("DESIGN"));
  const last = readFileSync(join(prompts, designPrompts.sort().at(-1)!), "utf8");
  assert.match(last, /Cover negative numbers/);
  write(root, "openspec/changes/t8/tasks.md", "- [ ] 1.1 Changed by hand\n");
});

test("manual verify pass needs an override", () => {
  const { devflow } = setup();
  devflow("start", "t7", "x", "--tier", "small");
  const r = devflow("complete", "t7", "verify", "pass", "--json");
  assert.equal(JSON.parse(r.err).error.reason, "verify_needs_run");
});
