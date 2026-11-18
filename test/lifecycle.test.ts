import { test } from "node:test";
import assert from "node:assert/strict";
import { nextStage, transition } from "../src/lifecycle.js";
import { DevflowError } from "../src/errors.js";
import { NOW, config, fail, ok, play, task, verify } from "./helpers.js";

const cfg = config();

function rejects(fn: () => unknown, reason: string) {
  assert.throws(fn, (e: unknown) => e instanceof DevflowError && e.reason === reason);
}

test("small task starts at implement and skips planning", () => {
  const t = task("small");
  assert.equal(nextStage(t, cfg).stage, "implement");
  assert.equal(nextStage(t, cfg).role?.model, "sonnet");
  const done = play(t, cfg, ok("implement"), ok("gates"));
  assert.equal(done.status, "DONE");
  assert.deepEqual([nextStage(done, cfg).stage, nextStage(done, cfg).reason], [null, "done"]);
});

test("medium task runs explore → design → approval → implement → gates → verify", () => {
  let t = task("medium");
  assert.equal(nextStage(t, cfg).stage, "explore");
  t = play(t, cfg, ok("explore"));
  assert.equal(nextStage(t, cfg).stage, "design");
  t = play(t, cfg, ok("design"));
  assert.deepEqual([nextStage(t, cfg).stage, nextStage(t, cfg).reason], [null, "awaiting_plan_approval"]);
  t = play(t, cfg, { kind: "approve" });
  assert.equal(nextStage(t, cfg).stage, "implement");
  t = play(t, cfg, ok("implement"));
  assert.equal(nextStage(t, cfg).stage, "gates");
  assert.equal(nextStage(t, cfg).role, undefined);
  t = play(t, cfg, ok("gates"));
  assert.equal(nextStage(t, cfg).stage, "verify");
  assert.equal(nextStage(t, cfg).role?.runner, "codex");
  t = play(t, cfg, verify("pass"));
  assert.equal(t.status, "DONE");
});

test("complex design uses design_complex role, falling back to design", () => {
  const t = play(task("complex"), cfg, ok("explore"));
  assert.equal(nextStage(t, cfg).role?.model, "fable");
  const noComplex = config();
  delete noComplex.roles.design_complex;
  assert.equal(nextStage(t, noComplex).role?.model, "opus");
});

test("next reports the attempt number and does not mutate", () => {
  const t = task("small");
  const before = JSON.stringify(t);
  assert.equal(nextStage(t, cfg).attempt, 1);
  assert.deepEqual(nextStage(t, cfg), nextStage(t, cfg));
  assert.equal(JSON.stringify(t), before);
});

test("out-of-order stage is rejected and state unchanged", () => {
  const t = task("medium");
  const before = JSON.stringify(t);
  rejects(() => transition(t, ok("implement"), cfg, NOW), "stage_not_next");
  assert.equal(JSON.stringify(t), before);
});

test("invalid outcome for a stage is rejected", () => {
  rejects(() => transition(task("medium"), { kind: "complete", stage: "explore", outcome: "pass" }, cfg, NOW), "invalid_outcome");
});

test("verify rework returns to implement without consuming an implement attempt", () => {
  const t = play(task("medium"), cfg, ok("explore"), ok("design"), { kind: "approve" }, ok("implement"), ok("gates"), verify("rework"));
  assert.equal(nextStage(t, cfg).stage, "implement");
  assert.equal(t.attempts.implement, 1);
  assert.equal(nextStage(t, cfg).attempt, 2);
  assert.equal(t.lastVerdict?.outcome, "rework");
});

test("implement limit reached moves the task to HUMAN", () => {
  const c = config({ limits: { implement: 2 } });
  const t = play(task("small"), c, fail("implement"), ok("implement"), fail("gates"));
  assert.equal(t.status, "HUMAN");
  assert.deepEqual([nextStage(t, c).stage, nextStage(t, c).reason], [null, "limit_reached"]);
});

test("verify limit reached moves the task to HUMAN", () => {
  const c = config({ limits: { verify: 1 } });
  const t = play(task("medium"), c, ok("explore"), ok("design"), { kind: "approve" }, ok("implement"), ok("gates"), verify("rework"));
  assert.equal(nextStage(t, c).reason, "limit_reached");
});

test("verify human verdict moves the task to HUMAN", () => {
  const t = play(task("medium"), cfg, ok("explore"), ok("design"), { kind: "approve" }, ok("implement"), ok("gates"), verify("human"));
  assert.equal(nextStage(t, cfg).reason, "verify_requested_human");
});

test("approve only when awaiting plan approval", () => {
  rejects(() => transition(task("medium"), { kind: "approve" }, cfg, NOW), "not_awaiting_approval");
});

test("resume from HUMAN resets counters and returns to implement", () => {
  const c = config({ limits: { implement: 1 } });
  let t = play(task("small"), c, fail("implement"));
  assert.equal(t.status, "HUMAN");
  t = play(t, c, { kind: "resume" });
  assert.equal(nextStage(t, c).stage, "implement");
  assert.equal(t.attempts.implement, 0);
  rejects(() => transition(t, { kind: "resume" }, c, NOW), "not_waiting_for_human");
});

test("small escalates to medium and restarts at explore with recorded reason", () => {
  let t = play(task("small"), cfg, ok("implement"), fail("gates"));
  t = play(t, cfg, { kind: "escalate", reason: "gates_failed_twice" });
  assert.equal(t.tier, "medium");
  assert.equal(nextStage(t, cfg).stage, "explore");
  const last = t.history.at(-1)!;
  assert.deepEqual([last.kind, last.from, last.to, last.reason], ["escalate", "small", "medium", "gates_failed_twice"]);
});

test("medium escalates to complex and re-runs design", () => {
  let t = play(task("medium"), cfg, ok("explore"), ok("design"), { kind: "approve" }, ok("implement"), ok("gates"), verify("rework"));
  t = play(t, cfg, { kind: "escalate", reason: "rework_twice" });
  assert.equal(t.tier, "complex");
  assert.equal(nextStage(t, cfg).stage, "design");
  assert.equal(nextStage(t, cfg).role?.model, "fable");
});

test("complex cannot escalate; done task cannot change tier", () => {
  rejects(() => transition(task("complex"), { kind: "escalate", reason: "x" }, cfg, NOW), "cannot_escalate");
  const done = play(task("small"), cfg, ok("implement"), ok("gates"));
  rejects(() => transition(done, { kind: "tier", tier: "medium" }, cfg, NOW), "task_done");
});

test("human tier change resumes a HUMAN task", () => {
  const c = config({ limits: { implement: 1 } });
  let t = play(task("medium"), c, ok("explore"), ok("design"), { kind: "approve" }, fail("implement"));
  assert.equal(t.status, "HUMAN");
  t = play(t, c, { kind: "tier", tier: "complex" });
  assert.equal(nextStage(t, c).stage, "design");
  t = play(t, c, { kind: "tier", tier: "small" });
  assert.equal(nextStage(t, c).stage, "implement");
  rejects(() => transition(t, { kind: "tier", tier: "small" }, c, NOW), "same_tier");
});

test("gates: blocked goes to HUMAN without touching counters or attempts", () => {
  const before = play(task("small"), cfg, ok("implement"));
  const t = play(before, cfg, { kind: "gates", outcome: "blocked", gate: "rollback", reason: "baseline_failed" });
  assert.deepEqual([t.status, t.humanReason], ["HUMAN", "baseline_failed"]);
  assert.deepEqual([t.counters, t.attempts], [before.counters, before.attempts]);
});

test("gates: repeated failures escalate before limits; files are not touched (tier only)", () => {
  const c = config({ limits: { escalate_after: 2, implement: 2 } });
  const t = play(task("small"), c, ok("implement"), fail("gates"), ok("implement"), fail("gates"));
  assert.equal(t.tier, "medium");
  assert.equal(nextStage(t, c).stage, "explore");
  const esc = t.history.at(-1)!;
  assert.deepEqual([esc.kind, esc.reason], ["escalate", "gates_failed_repeatedly"]);
  assert.deepEqual([t.counters.gatesFailedInARow, t.attempts.implement], [0, 0]);
});

test("gates: a zone violation escalates immediately; on complex it goes to HUMAN", () => {
  const zoneFail = { kind: "gates" as const, outcome: "fail" as const, gate: "zone", reason: "outside_zone" };
  const s = play(task("small"), cfg, ok("implement"), zoneFail);
  assert.deepEqual([s.tier, s.history.at(-1)!.reason], ["medium", "zone_violation"]);
  const c = play(task("complex"), cfg, ok("explore"), ok("design"), { kind: "approve" }, ok("implement"), zoneFail);
  assert.deepEqual([c.status, c.humanReason, c.tier], ["HUMAN", "zone_violation", "complex"]);
});

test("gates pass resets the failure counter", () => {
  const t = play(task("medium"), cfg, ok("explore"), ok("design"), { kind: "approve" }, ok("implement"), fail("gates"), ok("implement"), ok("gates"));
  assert.equal(t.counters.gatesFailedInARow, 0);
  assert.equal(nextStage(t, cfg).stage, "verify");
});

test("second rework on medium escalates to complex", () => {
  const c = config({ limits: { verify: 5 } });
  const toVerify = [ok("implement"), ok("gates")];
  const t = play(task("medium"), c, ok("explore"), ok("design"), { kind: "approve" }, ...toVerify, verify("rework"), ...toVerify, verify("rework"));
  assert.equal(t.tier, "complex");
  assert.equal(t.history.at(-1)!.reason, "rework_repeated");
  assert.equal(nextStage(t, c).stage, "design");
});

test("manual gates ok needs an override and is recorded as such", () => {
  const t = play(task("small"), cfg, ok("implement"));
  rejects(() => transition(t, { kind: "complete", stage: "gates", outcome: "ok" }, cfg, NOW), "gates_need_gate_run");
  const o = transition(t, { kind: "complete", stage: "gates", outcome: "ok", override: "checked by hand" }, cfg, NOW);
  assert.equal(o.status, "DONE");
  assert.deepEqual([o.history.at(-1)!.kind, o.history.at(-1)!.reason], ["override", "checked by hand"]);
  rejects(() => transition(task("small"), { kind: "gates", outcome: "pass" }, cfg, NOW), "stage_not_next");
});
