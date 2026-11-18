import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tempDir } from "./helpers.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

function devflow(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

const json = (s: string) => JSON.parse(s) as Record<string, any>;

test("small task end to end", () => {
  const dir = tempDir();
  assert.equal(devflow(dir, "init").code, 0);
  assert.equal(devflow(dir, "start", "fix-1", "Fix typo", "--tier", "small").code, 0);
  assert.equal(json(devflow(dir, "next", "fix-1").out).stage, "implement");
  assert.equal(json(devflow(dir, "complete", "fix-1", "implement", "ok").out).stage, "gates");
  const done = json(devflow(dir, "complete", "fix-1", "gates", "ok", "--override", "test").out);
  assert.deepEqual([done.stage, done.reason], [null, "done"]);
});

test("medium task end to end with approval and status", () => {
  const dir = tempDir();
  devflow(dir, "init");
  assert.equal(devflow(dir, "start", "feat-x", "Add export", "--tracker", "GF-12").code, 0);
  devflow(dir, "complete", "feat-x", "explore", "ok");
  const waiting = json(devflow(dir, "complete", "feat-x", "design", "ok").out);
  assert.equal(waiting.reason, "awaiting_plan_approval");
  assert.equal(json(devflow(dir, "approve", "feat-x").out).stage, "implement");
  devflow(dir, "complete", "feat-x", "implement", "ok");
  devflow(dir, "complete", "feat-x", "gates", "ok", "--override", "test");
  assert.equal(json(devflow(dir, "complete", "feat-x", "verify", "pass", "--override", "test").out).reason, "done");
  const status = json(devflow(dir, "status", "feat-x", "--json").out);
  assert.deepEqual([status.status, status.tracker], ["DONE", "GF-12"]);
});

test("status lists all tasks as a JSON array", () => {
  const dir = tempDir();
  devflow(dir, "init");
  devflow(dir, "start", "a", "A");
  devflow(dir, "start", "b", "B", "--tier", "small");
  const rows = JSON.parse(devflow(dir, "status", "--json").out) as unknown[];
  assert.equal(rows.length, 2);
  assert.match(devflow(dir, "status").out, /^a {2}medium {2}NEW/m);
});

test("domain errors exit 1 with a reason; usage errors exit 2", () => {
  const dir = tempDir();
  devflow(dir, "init");
  devflow(dir, "start", "t", "T");
  const bad = devflow(dir, "complete", "t", "implement", "ok", "--json");
  assert.equal(bad.code, 1);
  assert.equal(json(bad.err).error.reason, "stage_not_next");
  const dup = devflow(dir, "start", "t", "Again", "--json");
  assert.deepEqual([dup.code, json(dup.err).error.reason], [1, "task_exists"]);
  assert.equal(devflow(dir, "frobnicate").code, 2);
  assert.equal(devflow(dir, "start", "t2", "X", "--tier", "huge").code, 2);
});

test("commands outside a devflow project fail with no_project", () => {
  const dir = tempDir();
  const r = devflow(dir, "status", "--json");
  assert.deepEqual([r.code, json(r.err).error.reason], [1, "no_project"]);
});

test("escalate needs a reason and records it", () => {
  const dir = tempDir();
  devflow(dir, "init");
  devflow(dir, "start", "s", "S", "--tier", "small");
  assert.equal(devflow(dir, "escalate", "s").code, 2);
  assert.equal(json(devflow(dir, "escalate", "s", "--reason", "too big").out).stage, "explore");
  assert.match(devflow(dir, "status", "s").out, /escalate small → medium: too big/);
});
