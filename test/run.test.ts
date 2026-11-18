import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
  cfg.runners = { env: { pass: ["FAKE_VERDICT", "FAKE_VERIFY_EDIT", "FAKE_PROMPT_DIR", "FAKE_FAIL_ROLE", "FAKE_PLAN_CONFLICT", "FAKE_VERDICT_IN_ANSWER", "FAKE_BLOCKED"] } };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  sh(root, "git", ["add", "-A"]);
  sh(root, "git", ["commit", "-q", "-m", "config"]);
  const bin = fakeAgentBin(join(tempDir(), "bin"));
  const prompts = join(tempDir(), "prompts");
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, FAKE_PROMPT_DIR: prompts, ...extra };
  const devflowWith = (more: Record<string, string>, ...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, env: { ...env, ...more }, encoding: "utf8" });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  const devflow = (...args: string[]) => devflowWith({}, ...args);
  const state = (id: string) => JSON.parse(readFileSync(join(root, ".devflow", "runs", id, "state.json"), "utf8"));
  const lines = (out: string) => out.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  return { root, devflow, devflowWith, state, lines, prompts };
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

const implementPrompts = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.startsWith("IMPLEMENT"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"));

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
