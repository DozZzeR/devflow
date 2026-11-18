import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DEVFLOW_DIR } from "./config.js";
import { DevflowError } from "./errors.js";
import { openLog } from "./logs.js";
import { taskDir } from "./store.js";

export interface RunLock {
  runId: string;
  status: "starting" | "running";
  startedAt: string;
  pid?: number;
  log?: string;
}

const LOCK = "run.json";
const STARTING_TIMEOUT_MS = 60_000;
const CLI_JS = join(fileURLToPath(new URL(".", import.meta.url)), "cli.js");

const lockPath = (root: string, id: string) => join(taskDir(root, id), LOCK);

export function readLock(root: string, id: string): RunLock | undefined {
  const p = lockPath(root, id);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RunLock;
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A lock is stale when its process is gone, or it never left "starting". */
export function isStale(lock: RunLock): boolean {
  if (lock.status === "running") return !(lock.pid && alive(lock.pid));
  return Date.now() - Date.parse(lock.startedAt) > STARTING_TIMEOUT_MS;
}

/** Take the task's run lock exclusively; a stale lock is removed first. Throws run_active otherwise. */
export function acquireLock(root: string, id: string, lock: RunLock): void {
  const p = lockPath(root, id);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(p, JSON.stringify(lock), { flag: "wx" });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const existing = readLock(root, id);
      if (existing && !isStale(existing)) {
        throw new DevflowError("run_active", `Task ${id} already has an active run (${existing.runId}).`, existing);
      }
      rmSync(p, { force: true });
    }
  }
  throw new DevflowError("run_active", `Task ${id} has a run lock that could not be replaced.`);
}

/** The detached child confirms it owns the lock by writing its pid. */
export function adoptLock(root: string, id: string, runId: string): void {
  const lock = readLock(root, id);
  if (!lock || lock.runId !== runId) throw new DevflowError("run_active", `Run lock for ${id} is not ${runId}.`);
  writeFileSync(lockPath(root, id), JSON.stringify({ ...lock, status: "running", pid: process.pid }));
}

export function releaseLock(root: string, id: string, runId: string): void {
  const lock = readLock(root, id);
  if (lock?.runId === runId) rmSync(lockPath(root, id), { force: true });
}

export const newRunId = () => `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;

/** Reserve the lock, then start `devflow run <id> --run-id <runId>` detached with output to a run log. */
export function startDetached(root: string, id: string, extraArgs: string[], env: NodeJS.ProcessEnv): { runId: string; log: string } {
  const runId = newRunId();
  acquireLock(root, id, { runId, status: "starting", startedAt: new Date().toISOString() });
  try {
    const log = openLog(root, "run", id);
    log.close();
    const fd = openSync(log.path, "a");
    try {
      const child = spawn(process.execPath, [CLI_JS, "run", id, "--run-id", runId, ...extraArgs], {
        cwd: root,
        env,
        detached: true,
        stdio: ["ignore", fd, fd],
        windowsHide: true,
      });
      child.unref();
      writeFileSync(lockPath(root, id), JSON.stringify({ ...readLock(root, id)!, log: log.path }));
    } finally {
      closeSync(fd);
    }
    return { runId, log: log.path };
  } catch (e) {
    releaseLock(root, id, runId);
    throw e;
  }
}

/** Newest run log of a task, if any. */
export function latestRunLog(root: string, id: string): string | undefined {
  const dir = join(root, DEVFLOW_DIR, "runs", id, "logs");
  if (!existsSync(dir)) return undefined;
  const logs = readdirSync(dir)
    .filter((f) => /^run-\d+\.log$/.test(f))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
  return logs.at(-1);
}
