/** @file Create per-run logs and redact sensitive values before buffered output is persisted. */

import { closeSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { DEVFLOW_DIR } from "./config.js";
import { DevflowError } from "./errors.js";
import { validateId } from "./store.js";

/** Token and credential patterns replaced before writing a log line. */
const REDACTIONS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/g, "[REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED]"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[REDACTED]"],
  [/(Authorization["']?\s*[:=]\s*["']?)(?!Bearer\s)[^\s"']{8,}/gi, "$1[REDACTED]"],
  [/((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',}]{8,}/gi, "$1[REDACTED]"],
];

/** Mask recognized secrets in text while leaving other diagnostic output readable. */
export function redact(text: string): string {
  return REDACTIONS.reduce((t, [re, rep]) => t.replace(re, rep), text);
}

/** Create each missing directory under `base`, refusing any existing component that is a link. */
function safeMkdirs(root: string, parts: string[]): string {
  let dir = root;
  for (const part of parts) {
    dir = join(dir, part);
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      mkdirSync(dir);
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new DevflowError("unsafe_path", `${dir} is a link or not a directory; refusing to write logs through it.`);
    }
  }
  return dir;
}

/** Handle to one exclusively created log and its per-stream buffers. */
export interface LogFile {
  /** Filesystem location returned in stage or runner diagnostics. */
  path: string;
  /** Append a chunk to its stream buffer and write redacted complete lines. */
  write(chunk: string, stream?: "stdout" | "stderr"): void;
  /** Flush and redact the final partial lines, then release the descriptor. */
  close(): void;
}

/** Exclusively create a new log file for a role run, inside `<root>/.devflow`. */
export function openLog(root: string, role: string, task?: string): LogFile {
  if (!/^[a-z_]+$/.test(role)) throw new DevflowError("invalid_role", `Invalid role "${role}".`);
  let parts: string[];
  if (task !== undefined) {
    validateId(task);
    parts = [DEVFLOW_DIR, "runs", task, "logs"];
  } else {
    parts = [DEVFLOW_DIR, "logs"];
  }
  const dir = safeMkdirs(root, parts);
  const rel = relative(join(root, DEVFLOW_DIR), dir);
  if (rel.startsWith("..") || rel.split(sep).includes("..")) {
    throw new DevflowError("unsafe_path", `Log directory ${dir} escapes ${DEVFLOW_DIR}.`);
  }

  let fd: number | undefined;
  let path = "";
  for (let n = 1; fd === undefined; n++) {
    const name = task !== undefined ? `${role}-${n}.log` : `${role}-${new Date().toISOString().replace(/[:.]/g, "-")}-${n}.log`;
    path = join(dir, name);
    try {
      fd = openSync(path, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || n > 10_000) throw e;
    }
  }

  // One line buffer per stream, so interleaved stdout/stderr cannot split a token across redaction.
  const pending = { stdout: "", stderr: "" };
  const descriptor = fd;
  let closed = false;
  return {
    path,
    /** Buffer incomplete lines separately for each stream before redaction. */
    write(chunk: string, stream: "stdout" | "stderr" = "stdout") {
      if (closed) return;
      pending[stream] += chunk;
      const lastNewline = pending[stream].lastIndexOf("\n");
      if (lastNewline >= 0) {
        writeSync(descriptor, redact(pending[stream].slice(0, lastNewline + 1)));
        pending[stream] = pending[stream].slice(lastNewline + 1);
      }
    },
    /** Flush pending output once and close the file descriptor. */
    close() {
      if (closed) return;
      closed = true;
      for (const s of ["stdout", "stderr"] as const) {
        if (pending[s]) writeSync(descriptor, redact(pending[s]) + "\n");
        pending[s] = "";
      }
      closeSync(descriptor);
    },
  };
}
