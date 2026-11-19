/** @file Inspect Git changes and manage temporary checkouts used by verification and rollback. */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DevflowError } from "./errors.js";
import { buildChildEnv, resolveCommand } from "./proc.js";

/** Run git synchronously with an allowlisted environment; returns stdout or throws. */
export function git(cwd: string, args: string[], opts: { allowFail?: boolean } = {}): { code: number; stdout: string; stderr: string } {
  const env = buildChildEnv(process.env);
  const exe = resolveCommand("git", env);
  if (!exe) throw new DevflowError("no_git", "git was not found on PATH.");
  const r = spawnSync(exe, args, { cwd, env, encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  const result = { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  if (result.code !== 0 && !opts.allowFail) {
    throw new DevflowError("git_failed", `git ${args.join(" ")} failed: ${result.stderr.trim() || r.error?.message || "unknown error"}`);
  }
  return result;
}

/** Repository root and project prefix for projects nested inside a Git checkout. */
export interface RepoInfo {
  /** Absolute repository root. */
  toplevel: string;
  /** Project directory relative to the repository root, with trailing "/" or "" at the root. */
  prefix: string;
}

/** Repository info for a project directory, or undefined when it is not inside a git work tree. */
export function repoInfo(root: string): RepoInfo | undefined {
  let r;
  try {
    r = git(root, ["rev-parse", "--show-toplevel", "--show-prefix"], { allowFail: true });
  } catch {
    return undefined;
  }
  if (r.code !== 0) return undefined;
  const [toplevel = "", prefix = ""] = r.stdout.split(/\r?\n/);
  return { toplevel: resolve(toplevel), prefix };
}

/** Resolve the current HEAD when a commit exists, for recording the task base. */
export function headCommit(root: string): string | undefined {
  const r = git(root, ["rev-parse", "--verify", "HEAD"], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/** Runtime paths omitted from the task's Git change set. */
const EXCLUDED = [/^\.devflow\/runs(\/|$)/, /^\.devflow\/logs(\/|$)/, /^\.devflow\/jobs(\/|$)/];

/** Project-relative paths changed since `base`: tracked changes (both rename paths) plus untracked, non-ignored files. */
export function changeSet(root: string, base: string): string[] {
  const info = repoInfo(root);
  if (!info) throw new DevflowError("no_git", `${root} is not inside a git repository.`);
  const scope = info.prefix ? ["--", "."] : [];
  const paths = new Set<string>();

  const diff = git(root, ["diff", "--name-status", "-z", "--find-renames", "--no-ext-diff", base, ...scope]).stdout.split("\0");
  for (let i = 0; i < diff.length; ) {
    const status = diff[i++];
    if (!status) continue;
    const count = /^[RC]/.test(status) ? 2 : 1;
    for (let k = 0; k < count; k++) {
      const p = diff[i++];
      if (p) paths.add(p);
    }
  }
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--full-name", ...scope]).stdout.split("\0");
  for (const p of untracked) if (p) paths.add(p);

  const out: string[] = [];
  for (const repoPath of paths) {
    if (info.prefix && !repoPath.startsWith(info.prefix)) continue;
    const rel = repoPath.slice(info.prefix.length);
    if (!rel || EXCLUDED.some((re) => re.test(rel))) continue;
    out.push(rel);
  }
  return out.sort();
}

/** Create a detached temporary worktree at `base`. Returns its path and the project dir inside it. */
export function addWorktree(root: string, base: string): { path: string; projectDir: string } {
  const info = repoInfo(root);
  if (!info) throw new DevflowError("no_git", `${root} is not inside a git repository.`);
  const parent = mkdtempSync(join(tmpdir(), "devflow-wt-"));
  const path = join(parent, "wt");
  try {
    git(info.toplevel, ["worktree", "add", "--detach", path, base]);
  } catch (e) {
    // A partial add must not leave a registered worktree or a temp directory behind.
    git(info.toplevel, ["worktree", "remove", "--force", path], { allowFail: true });
    rmSync(parent, { recursive: true, force: true });
    throw e;
  }
  return { path, projectDir: info.prefix ? join(path, info.prefix) : path };
}

/** Delay the next cleanup attempt when Windows still holds a worktree file. */
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Cut a worktree loose from the repository: drop its `.git` link so commands run inside it cannot reach
 * the shared object store, history or other branches (used for the isolated verifier copy).
 */
export function detachWorktreeGit(path: string): void {
  rmSync(join(path, ".git"), { force: true, recursive: true });
}

/** Remove a detached worktree directory and drop its stale registration. */
export function removeDetached(root: string, path: string): boolean {
  for (let attempt = 0; attempt < 3 && existsSync(path); attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      sleepSync(500 * (attempt + 1));
    }
  }
  if (existsSync(path)) return false;
  rmSync(resolve(path, ".."), { recursive: true, force: true });
  const info = repoInfo(root);
  if (info) git(info.toplevel, ["worktree", "prune"], { allowFail: true }); // only drops entries whose directory is gone
  return true;
}

/** Remove one worktree (never a repository-wide prune). Returns false if it could not be removed. */
export function removeWorktree(root: string, path: string): boolean {
  const info = repoInfo(root);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (info) git(info.toplevel, ["worktree", "remove", "--force", path], { allowFail: true });
    if (!existsSync(path)) break;
    sleepSync(500 * (attempt + 1));
  }
  if (existsSync(path)) return false;
  rmSync(resolve(path, ".."), { recursive: true, force: true });
  return true;
}
