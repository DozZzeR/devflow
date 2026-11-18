import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initProject } from "../src/config.js";
import { DevflowError } from "../src/errors.js";
import { createTask, listTaskIds, loadTask, saveTask, taskDir } from "../src/store.js";
import { NOW, task, tempDir } from "./helpers.js";

function project(): string {
  const dir = tempDir();
  initProject(dir);
  return dir;
}

const isReason = (reason: string) => (e: unknown) => e instanceof DevflowError && e.reason === reason;

test("create, load and save round-trip with no temp files left", () => {
  const root = project();
  const t = task();
  createTask(root, t);
  saveTask(root, { ...t, updatedAt: "2026-11-17T13:00:00.000Z" });
  assert.equal(loadTask(root, "t1").updatedAt, "2026-11-17T13:00:00.000Z");
  assert.deepEqual(readdirSync(taskDir(root, "t1")), ["state.json"]);
  assert.deepEqual(listTaskIds(root), ["t1"]);
});

test("duplicate id is refused and existing state unchanged", () => {
  const root = project();
  createTask(root, task());
  const before = readFileSync(join(taskDir(root, "t1"), "state.json"), "utf8");
  assert.throws(() => createTask(root, { ...task(), description: "other" }), isReason("task_exists"));
  assert.equal(readFileSync(join(taskDir(root, "t1"), "state.json"), "utf8"), before);
});

test("invalid JSON is reported as invalid_state and left untouched", () => {
  const root = project();
  createTask(root, task());
  const file = join(taskDir(root, "t1"), "state.json");
  writeFileSync(file, "{ broken");
  assert.throws(() => loadTask(root, "t1"), isReason("invalid_state"));
  assert.equal(readFileSync(file, "utf8"), "{ broken");
});

test("unknown schema version is reported as invalid_state", () => {
  const root = project();
  createTask(root, task());
  const file = join(taskDir(root, "t1"), "state.json");
  writeFileSync(file, JSON.stringify({ ...task(), schema: 3 }));
  assert.throws(() => loadTask(root, "t1"), (e: unknown) => isReason("invalid_state")(e) && /schema version 3/.test((e as Error).message));
});

test("ids that could escape the runs directory are rejected", () => {
  const root = project();
  for (const id of ["../x", "a/b", "..", "", ".hidden"]) {
    assert.throws(() => taskDir(root, id), isReason("invalid_id"), id);
  }
  assert.equal(NOW.length > 0, true);
});

test("schema-1 files are upgraded on load and saved as schema 2", () => {
  const root = project();
  createTask(root, task());
  const file = join(taskDir(root, "t1"), "state.json");
  const v1 = { ...task(), schema: 1 } as Record<string, unknown>;
  delete v1.counters;
  writeFileSync(file, JSON.stringify(v1));
  const loaded = loadTask(root, "t1");
  assert.deepEqual([loaded.schema, loaded.counters], [2, { gatesFailedInARow: 0, reworks: 0, staleEvidence: 0 }]);
  saveTask(root, loaded);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).schema, 2);
});
