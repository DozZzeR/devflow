/** @file Validate task identifiers and persist versioned task records under the project run directory. */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DEVFLOW_DIR } from "./config.js";
import { DevflowError } from "./errors.js";
import { COUNTERS_ZERO, TaskStateSchema, type TaskState } from "./lifecycle.js";

/** Directory containing the individual task records. */
export const RUNS_DIR = "runs";
/** JSON filename holding one task's current state and history. */
export const STATE_FILE = "state.json";

/** Allowed task IDs for constructing project-relative run paths. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Reject invalid task IDs before using them as filesystem components. */
export function validateId(id: string): void {
  if (!ID_PATTERN.test(id) || id.includes("..")) {
    throw new DevflowError(
      "invalid_id",
      `Invalid task id "${id}": use letters, digits, ".", "_" or "-", up to 64 characters, starting with a letter or digit.`,
    );
  }
}

/** Resolve the project's parent directory for task records. */
export function runsDir(root: string): string {
  return join(root, DEVFLOW_DIR, RUNS_DIR);
}

/** Resolve one validated task ID to its directory. */
export function taskDir(root: string, id: string): string {
  validateId(id);
  return join(runsDir(root), id);
}

/** Delay the next cleanup attempt when Windows still holds a worktree file. */
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Write via temp file + rename; retry rename briefly on Windows sharing violations. */
export function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, content, { flag: "wx" });
  const retryable = new Set(["EPERM", "EACCES", "EBUSY"]);
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (!retryable.has(code) || attempt >= 5) {
        rmSync(tmp, { force: true });
        throw e;
      }
      sleepSync(20 * (attempt + 1));
    }
  }
}

/** Reserve a new task directory and atomically write the initial state. */
export function createTask(root: string, task: TaskState): void {
  const dir = taskDir(root, task.id);
  mkdirSync(runsDir(root), { recursive: true });
  try {
    mkdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new DevflowError("task_exists", `Task "${task.id}" already exists in ${dir}.`);
    }
    throw e;
  }
  writeFileAtomic(join(dir, STATE_FILE), serialize(task));
}

/** Replace the JSON state of an existing task using an atomic file rename. */
export function saveTask(root: string, task: TaskState): void {
  writeFileAtomic(join(taskDir(root, task.id), STATE_FILE), serialize(task));
}

/** Read, upgrade and validate the task record, reporting absent or invalid state. */
export function loadTask(root: string, id: string): TaskState {
  const file = join(taskDir(root, id), STATE_FILE);
  if (!existsSync(file)) throw new DevflowError("no_task", `Task "${id}" not found.`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new DevflowError("invalid_state", `${file} is not valid JSON (${(e as Error).message}); left untouched.`);
  }
  const parsed = TaskStateSchema.safeParse(upgrade(raw));
  if (!parsed.success) {
    const schema = (raw as { schema?: unknown } | null)?.schema;
    const what = schema !== 1 && schema !== 2 ? `unknown schema version ${JSON.stringify(schema)}` : "invalid content";
    throw new DevflowError("invalid_state", `${file}: ${what}; left untouched.`, parsed.error.issues);
  }
  if (parsed.data.id !== id) {
    throw new DevflowError("invalid_state", `${file}: id "${parsed.data.id}" does not match directory "${id}"; left untouched.`);
  }
  return parsed.data;
}

/** Discover task directories that contain a state file. */
export function listTaskIds(root: string): string[] {
  const dir = runsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, STATE_FILE)))
    .map((d) => d.name)
    .sort();
}

/** Schema 1 → 2 in memory: no base, no zone, zero counters. Other versions pass through unchanged. */
export function upgrade(raw: unknown): unknown {
  if (raw && typeof raw === "object" && (raw as { schema?: unknown }).schema === 1) {
    const { base: _b, zone: _z, ...rest } = raw as Record<string, unknown>;
    void _b;
    void _z;
    return { ...rest, schema: 2, counters: { ...COUNTERS_ZERO } };
  }
  return raw;
}

/** Serialize state as indented JSON terminated by a newline. */
function serialize(task: TaskState): string {
  return JSON.stringify(task, null, 2) + "\n";
}
