/** @file Track detached CLI jobs that run independently of a task's stage loop. */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEVFLOW_DIR } from "./config.js";
import { DevflowError } from "./errors.js";
import { newRunId } from "./background.js";
import { openLog } from "./logs.js";
import { writeFileAtomic } from "./store.js";

/** Persistent metadata for a detached command and its completion. */
export interface JobInfo {
  /** Validated identifier used to locate this job's metadata. */
  jobId: string;
  /** CLI subcommand and arguments being run by the child. */
  args: string[];
  /** Time the parent created the job. */
  startedAt: string;
  /** File receiving the detached child's standard streams. */
  log: string;
  /** Child process identifier once available. */
  pid?: number;
  /** Completion status recorded by the child; null represents an unavailable exit code. */
  exitCode?: number | null;
  /** Timestamp recorded on completion, absent while the result is pending. */
  endedAt?: string;
}

/** Resolve the project-local directory for detached job metadata. */
const jobsDir = (root: string) => join(root, DEVFLOW_DIR, "jobs");
/** Validate a job ID before resolving its JSON record. */
const jobFile = (root: string, jobId: string) => {
  if (!/^[0-9]{14}-[0-9a-f]{6}$/.test(jobId)) throw new DevflowError("invalid_job", `Invalid job id "${jobId}".`);
  return join(jobsDir(root), `${jobId}.json`);
};

/**
 * The devflow entry script to re-invoke: the running one when it is devflow itself (dist/src/cli.js or a
 * plugin's bin/devflow.mjs), otherwise the cli.js next to this module (in-process callers such as tests).
 */
export const selfScript = (): string => {
  const argv1 = process.argv[1] ?? "";
  if (/(?:[\\/]cli\.js|[\\/]devflow\.mjs)$/.test(argv1)) return argv1;
  return join(dirname(fileURLToPath(import.meta.url)), "cli.js");
};

/** Load the requested job record or raise no_job when it is missing. */
export function readJob(root: string, jobId: string): JobInfo {
  const f = jobFile(root, jobId);
  if (!existsSync(f)) throw new DevflowError("no_job", `Job ${jobId} not found.`);
  return JSON.parse(readFileSync(f, "utf8")) as JobInfo;
}

/** Check whether the recorded child process still exists. */
function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Report active only while the job has no end timestamp and its PID is alive. */
export function jobActive(job: JobInfo): boolean {
  return job.endedAt === undefined && alive(job.pid);
}

/** Start `devflow <args...>` as a detached job with its own log; returns at once. */
export function startJob(root: string, args: string[], env: NodeJS.ProcessEnv): JobInfo {
  mkdirSync(jobsDir(root), { recursive: true });
  const jobId = newRunId();
  const log = openLog(root, "job");
  log.close();
  const info: JobInfo = { jobId, args, startedAt: new Date().toISOString(), log: log.path };
  writeFileSync(jobFile(root, jobId), JSON.stringify(info), { flag: "wx" });
  const fd = openSync(log.path, "a");
  try {
    const child = spawn(process.execPath, [selfScript(), "__job", jobId, ...args], {
      cwd: root,
      env,
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    });
    child.unref();
    info.pid = child.pid;
    writeFileAtomic(jobFile(root, jobId), JSON.stringify(info));
  } finally {
    closeSync(fd);
  }
  return info;
}

/** Called inside the job process when the wrapped command ends. */
export function finishJob(root: string, jobId: string, exitCode: number | null): void {
  const info = readJob(root, jobId);
  writeFileAtomic(jobFile(root, jobId), JSON.stringify({ ...info, pid: info.pid ?? process.pid, exitCode, endedAt: new Date().toISOString() }));
}

/** Return the last lines of a job log for polling clients. */
export function tail(path: string, lines = 200): string {
  if (!existsSync(path)) return "";
  const all = readFileSync(path, "utf8").split(/\r?\n/);
  return all.slice(-lines - 1).join("\n").trimEnd();
}
