/** @file Bind approvals and test evidence to the plan revision, Git base, configuration and changed content. */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Config } from "./config.js";
import { changeSet } from "./git.js";

/** Hash text or file bytes with SHA-256 for deterministic evidence digests. */
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** Hash file contents or link targets without following the final path component. */
export function pathHashes(root: string, paths: string[]): Record<string, string | null> {
  return Object.fromEntries(paths.map((path) => {
    const absolute = join(root, path);
    try {
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) return [path, `link:${sha(readlinkSync(absolute, { encoding: "buffer" }))}`];
      if (stat.isFile()) return [path, `sha256:${sha(readFileSync(absolute))}`];
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    return [path, null];
  }));
}

/** Hash of the configuration the gates actually used (stable key order). */
export function configHash(config: Config): string {
  /** Sort object keys recursively before hashing configuration, preserving array order. */
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]))
        : v;
  return sha(JSON.stringify(stable(config)));
}

/**
 * Evidence snapshot: base commit, gate config and, for every change-set path, its mode and content (or deletion).
 * Two runs that judged the same code produce the same digest.
 */
export function snapshotDigest(root: string, base: string, config: Config): string {
  const h = createHash("sha256");
  h.update(`base\0${base}\0config\0${configHash(config)}\0`);
  for (const p of changeSet(root, base)) {
    const abs = join(root, p);
    let entry: string;
    try {
      const st = lstatSync(abs);
      const mode = process.platform === "win32" ? 0 : st.mode & 0o777;
      const content = st.isSymbolicLink() ? `link` : st.isFile() ? sha(readFileSync(abs)) : `other`;
      entry = `${mode.toString(8)}\0${content}`;
    } catch {
      entry = "<deleted>";
    }
    h.update(`${p}\0${entry}\0`);
  }
  return h.digest("hex");
}

/** Normalise tasks.md so ticking checkboxes does not change the plan digest. */
export function normaliseTasks(text: string): string {
  return text.replace(/^(\s*[-*+]\s+)\[[ xX]\]/gm, "$1[ ]").replace(/\r\n/g, "\n");
}

/** Collect regular files in the plan folder using root-relative portable paths. */
function walk(dir: string, rootDir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) walk(abs, rootDir, out);
    else if (e.isFile()) out.push(relative(rootDir, abs).split(sep).join("/"));
  }
}

/** Resolve the OpenSpec change directory for a task. */
export function changeFolder(root: string, id: string): string {
  return join(root, "openspec", "changes", id);
}

/** Files of a change folder, project-relative to the folder, sorted. */
export function changeFiles(root: string, id: string): string[] {
  const dir = changeFolder(root, id);
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  walk(dir, dir, out);
  return out.sort();
}

/** Digest of the plan: every file of the change folder, with tasks.md checkbox state erased. */
export function planDigest(root: string, id: string, revision = 1): string {
  const dir = changeFolder(root, id);
  const h = createHash("sha256");
  h.update(`revision\0${revision}\0`);
  for (const f of changeFiles(root, id)) {
    let content = readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n");
    if (f === "tasks.md") content = normaliseTasks(content);
    h.update(`${f}\0${sha(content)}\0`);
  }
  return h.digest("hex");
}

/** Per-file content hashes of a change folder, for freshness checks around a design run. */
export function changeFileHashes(root: string, id: string): Map<string, string> {
  const dir = changeFolder(root, id);
  return new Map(changeFiles(root, id).map((f) => [f, sha(readFileSync(join(dir, f)))]));
}
