/** @file Exercise routing and transition invariants from domain events without launching role processes. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { nextStage, TaskStateSchema, transition } from "../src/lifecycle.js";
import { DevflowError } from "../src/errors.js";
import { NOW, config, fail, ok, play, task, verify } from "./helpers.js";

/** Shared validated configuration for lifecycle transition cases. */
const cfg = config();

test("pauses preserve state and attempts, even at a limit of one", () => {
  const initial = task("small");
  const configWithLimit = config({ limits: { implement: 1 } });
  const pause = { kind: "pause", stage: "implement", runner: "claude", reset: "5pm" } as const;
  const paused = play(initial, configWithLimit, pause, pause, pause);
  assert.equal(paused.status, initial.status);
  assert.equal(paused.tier, initial.tier);
  assert.deepEqual(paused.attempts, initial.attempts);
  assert.deepEqual(paused.counters, initial.counters);
  assert.equal(nextStage(paused, cfg).attempt, 1);
  assert.deepEqual(nextStage(paused, cfg).pause, { stage: "implement", runner: "claude", reason: "usage_limit", reset: "5pm", at: NOW });
  assert.deepEqual(paused.history.at(-1), { at: NOW, kind: "pause", stage: "implement", reason: "usage_limit", to: "5pm" });
  rejects(() => play(task(), cfg, pause), "stage_not_next");
});

test("Pause keeps attempts already spent and preserves the next attempt number", () => {
  const failed = play(task("small"), cfg, fail("implement"));
  assert.equal(failed.attempts.implement, 1);
  const paused = play(failed, cfg, { kind: "pause", stage: "implement", runner: "claude" });
  assert.equal(paused.status, failed.status);
  assert.equal(paused.attempts.implement, 1);
  assert.equal(nextStage(paused, cfg).stage, "implement");
  assert.equal(nextStage(paused, cfg).attempt, 2);
  assert.deepEqual(nextStage(paused, cfg).pause, paused.pause);
});

test("the next stage outcome clears its pause", () => {
  const paused = play(task(), cfg, { kind: "pause", stage: "explore", runner: "codex" });
  assert.equal(play(paused, cfg, ok("explore")).pause, undefined);
});

test("Review pause in next requires delegated approval and clears on approval", () => {
  const designed = play(task(), cfg, ok("explore"), ok("design"));
  const pause = { kind: "pause", stage: "review", runner: "claude" } as const;
  rejects(() => play(designed, cfg, pause), "stage_not_next");
  const paused = play(designed, cfg, { kind: "delegate", to: "model" }, pause);
  assert.equal(paused.pause?.stage, "review");
  const next = nextStage(paused, cfg);
  assert.equal(next.stage, "review");
  assert.equal(next.reason, "awaiting_plan_approval");
  assert.deepEqual(next.role, cfg.roles.review ?? cfg.roles.design_complex ?? cfg.roles.design);
  assert.equal(next.attempt, undefined);
  const approved = play(paused, cfg, { kind: "approve" });
  assert.equal(approved.pause, undefined);
  assert.equal(nextStage(approved, cfg).stage, "implement");
  assert.deepEqual(paused.history.at(-1), { at: NOW, kind: "pause", reason: "usage_limit", results: "review" });
  assert.equal(play(paused, cfg, { kind: "delegate", to: "human" }).pause, undefined);
});

test("schema 2 accepts older state and retains only the initial dirty snapshot", () => {
  const original = task("small");
  const state = TaskStateSchema.parse(JSON.parse(JSON.stringify(original)));
  assert.deepEqual(state, original);
  const snapped = play(state, cfg, { kind: "dirty_snapshot", paths: { "README.md": "sha256:example", "docs/old.md": null } });
  const retried = play(snapped, cfg, { kind: "dirty_snapshot", paths: {} });
  assert.deepEqual(TaskStateSchema.parse(retried).dirtyAtImplement, snapped.dirtyAtImplement);
  assert.deepEqual(retried.history.filter((h) => h.kind === "dirty"), [{ kind: "dirty", at: NOW, results: "2 paths" }]);
});

test("dirty snapshot preserves a path named __proto__ through state parsing", () => {
  const paths = { ["__proto__"]: "sha256:example" };
  const state = play(task("small"), cfg, { kind: "dirty_snapshot", paths });
  const loaded = TaskStateSchema.parse(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(loaded.dirtyAtImplement?.paths, paths);
});

/** Assert that an invalid transition raises the expected domain reason. */
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
  const withFable = config();
  withFable.roles.design_complex = { runner: "claude", model: "fable" };
  assert.equal(nextStage(t, withFable).role?.model, "fable");
  assert.equal(nextStage(t, cfg).role?.model, "opus"); // default preset: no Fable
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
  assert.equal(nextStage(t, cfg).role?.model, "opus");
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
  assert.equal(t.planRevision, task("small").planRevision);
  assert.equal(esc.results, undefined);
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

test("second rework on medium starts one plan revision and invalidates the old approval", () => {
  const c = config({ limits: { verify: 5 } });
  const approved = { ...task("medium"), status: "PLAN_APPROVED" as const, planRevision: 4, planDigest: "approved" };
  const gatePass = { kind: "gates", outcome: "pass", snapshot: "snapshot" } as const;
  const t = play(approved, c, ok("implement"), gatePass, verify("rework"), ok("implement"), gatePass, verify("rework"));
  assert.equal(t.tier, "complex");
  assert.equal(t.status, "EXPLORED");
  assert.equal(t.planRevision, 5);
  assert.equal(t.planDigest, undefined);
  assert.equal(t.gatesSnapshot, undefined);
  assert.deepEqual(t.history.filter(h => h.kind === "escalate"), [
    { at: NOW, kind: "escalate", from: "medium", to: "complex", reason: "rework_repeated", results: "revision 5" },
  ]);
  assert.equal(nextStage(t, c).stage, "design");
  const failed = play(t, c, fail("design"));
  assert.equal(failed.planRevision, 5);
  assert.equal(failed.status, "EXPLORED");
  const redesigned = play(failed, c, ok("design"));
  assert.equal(redesigned.planRevision, 5);
  assert.equal(redesigned.status, "DESIGNED");
  rejects(() => transition(redesigned, { kind: "approve", revision: 4 }, c, NOW), "plan_moved");
});

test("zone violations and repeated gate failures start a medium task's next revision", () => {
  const c = config({ limits: { escalate_after: 2 } });
  const approved = { ...task("medium"), status: "PLAN_APPROVED" as const, planRevision: 2, planDigest: "approved" };
  const zone = play(approved, c, ok("implement"), { kind: "gates", outcome: "fail", gate: "zone", reason: "outside_zone" });
  const repeated = play(approved, c, ok("implement"), fail("gates"), ok("implement"), fail("gates"));
  for (const [t, reason] of [[zone, "zone_violation"], [repeated, "gates_failed_repeatedly"]] as const) {
    assert.deepEqual([t.tier, t.status, t.planRevision], ["complex", "EXPLORED", 3]);
    assert.deepEqual([t.history.at(-1)?.reason, t.history.at(-1)?.results], [reason, "revision 3"]);
  }
});

test("manual gates ok needs an override and is recorded as such", () => {
  const t = play(task("small"), cfg, ok("implement"));
  rejects(() => transition(t, { kind: "complete", stage: "gates", outcome: "ok" }, cfg, NOW), "gates_need_gate_run");
  const o = transition(t, { kind: "complete", stage: "gates", outcome: "ok", override: "checked by hand" }, cfg, NOW);
  assert.equal(o.status, "DONE");
  assert.deepEqual([o.history.at(-1)!.kind, o.history.at(-1)!.reason], ["override", "checked by hand"]);
  rejects(() => transition(task("small"), { kind: "gates", outcome: "pass" }, cfg, NOW), "stage_not_next");
});

test("automatic escalation resets every attempt counter", () => {
  const c = config({ limits: { verify: 5 } });
  const toVerify = [ok("implement"), ok("gates")];
  const t = play(task("medium"), c, ok("explore"), ok("design"), { kind: "approve" }, ...toVerify, verify("rework"), ...toVerify, verify("rework"));
  assert.deepEqual(t.attempts, { explore: 0, design: 0, implement: 0, verify: 0 });
});
