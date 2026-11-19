/** @file Evaluate scope, test and rollback evidence and classify operational failures for the lifecycle. */

import { copyFileSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseConfig, type Config } from "./config.js";
import { DevflowError } from "./errors.js";
import { addWorktree, changeSet, git, removeWorktree, repoInfo } from "./git.js";
import { matchesAny } from "./glob.js";
import type { GateOutcome, TaskState } from "./lifecycle.js";
import { openLog } from "./logs.js";
import { launchShell } from "./proc.js";
import { pathHashes } from "./snapshot.js";
import { outsideZone } from "./zone.js";

/** Execution order for checking scope, the working tree and regression sensitivity. */
export const GATE_NAMES = ["zone", "tests", "rollback"] as const;
/** Name accepted by the standalone gate command. */
export type GateName = (typeof GATE_NAMES)[number];

/** Evidence and diagnostics returned by one deterministic gate. */
export interface GateResult {
  /** Gate that produced this result. */
  name: GateName;
  /** Pass advances, fail requests correction, and blocked requires intervention when recorded. */
  outcome: GateOutcome;
  /** Machine-readable explanation for a failed or blocked check. */
  reason?: string;
  /** Gate-specific evidence such as changed paths, exit codes or log locations. */
  details?: unknown;
  /** Wall-clock duration of this gate in milliseconds. */
  durationMs: number;
  /** Non-fatal conditions retained even when the check passes. */
  warnings?: string[];
}

/** Project, task and trusted configuration against which a gate runs. */
export interface GateContext {
  /** Working project directory used for Git and command execution. */
  root: string;
  /** Task carrying the approved zone and base revision. */
  task: TaskState;
  /** Effective configuration selected for the check. */
  config: Config;
  /** Environment supplied to setup, generation and test commands. */
  parentEnv?: NodeJS.ProcessEnv;
}

/** Build a gate result for a check that could not establish an outcome. */
const blocked = (name: GateName, reason: string, started: number, details?: unknown): GateResult => ({
  name,
  outcome: "blocked",
  reason,
  durationMs: Date.now() - started,
  ...(details === undefined ? {} : { details }),
});

/**
 * Config the gates trust: the one committed at the task base, so a role cannot change the test command,
 * test paths or setup that the gates will execute. Falls back to the working-tree config when the base has none.
 */
export function gateConfig(root: string, base: string | undefined, workingConfig: Config): { config: Config; source: "base" | "working_tree" } {
  const info = repoInfo(root);
  if (!info || !base) return { config: workingConfig, source: "working_tree" };
  const r = git(root, ["show", `${base}:${info.prefix}.devflow/config.json`], { allowFail: true });
  if (r.code !== 0) {
    // No committed config at the base: the working copy is only trusted if it is not part of the change.
    if (changeSet(root, base).includes(".devflow/config.json")) {
      throw new DevflowError("untrusted_config", ".devflow/config.json is not committed at the base and was changed; commit it or reset it.");
    }
    return { config: workingConfig, source: "working_tree" };
  }
  try {
    return { config: parseConfig(JSON.parse(r.stdout)), source: "base" };
  } catch {
    throw new DevflowError("invalid_config", "The .devflow/config.json committed at the task base is invalid.");
  }
}

/** Common preconditions: git present and a base recorded. */
function precheck(name: GateName, ctx: GateContext, started: number): GateResult | undefined {
  if (!repoInfo(ctx.root)) return blocked(name, "no_git", started);
  if (!ctx.task.base) return blocked(name, "no_base", started);
  return undefined;
}

/** Compare changes since the base against the approved write globs and generated outputs. */
export function zoneGate(ctx: GateContext): GateResult {
  const started = Date.now();
  const pre = precheck("zone", ctx, started);
  if (pre) return pre;
  const zone = ctx.task.zone ?? [];
  if (!zone.length) {
    if (ctx.task.tier === "small") {
      return { name: "zone", outcome: "pass", warnings: ["no_zone"], durationMs: Date.now() - started };
    }
    return blocked("zone", "no_zone", started);
  }
  const changes = changeSet(ctx.root, ctx.task.base!);
  const effectiveZone = [...zone, ...(ctx.config.build?.outputs ?? [])];
  /** Exclude this task's own OpenSpec change folder from code-zone enforcement. */
  const outsidePlan = (path: string) => !path.startsWith(`openspec/changes/${ctx.task.id}/`);
  const outside = outsideZone(changes.filter(outsidePlan), effectiveZone);
  const snapshot = ctx.task.dirtyAtImplement?.paths ?? {};
  const candidates = outside.filter((path) => Object.hasOwn(snapshot, path));
  const current = pathHashes(ctx.root, candidates);
  const preexisting = candidates.filter((path) => current[path] === snapshot[path]);
  const exempt = new Set(preexisting);
  const changed = new Set(changes);
  const reverted = outsideZone(Object.keys(snapshot).filter((path) => outsidePlan(path) && !changed.has(path)), effectiveZone);
  const counted = [...outside.filter((path) => !exempt.has(path)), ...reverted].sort();
  const warnings = preexisting.map((path) => `preexisting_change:${path}`);
  return counted.length
    ? { name: "zone", outcome: "fail", reason: "outside_zone", details: { outside: counted, preexisting }, warnings, durationMs: Date.now() - started }
    : { name: "zone", outcome: "pass", details: { changed: changes.length, preexisting }, warnings, durationMs: Date.now() - started };
}

/** Process result and log used to classify a test or setup phase. */
interface TestRun {
  /** Process exit status, or null if normal completion was unavailable. */
  exitCode: number | null;
  /** Whether the configured time budget expired. */
  timedOut: boolean;
  /** Whether terminating the process tree could not be confirmed. */
  killFailed?: boolean;
  /** Log file for the command in this phase. */
  log: string;
}

/** Execute a configured command in the given directory, enforce the test timeout and close its log. */
export async function runCommand(ctx: GateContext, command: string, cwd: string, label: string): Promise<TestRun> {
  const log = openLog(ctx.root, label, ctx.task.id);
  try {
    log.write(`$ ${command}\n# cwd: ${cwd}\n`);
    const r = await launchShell(command, {
      cwd,
      env: { ...(ctx.parentEnv ?? process.env) },
      stdin: "",
      timeoutMs: ctx.config.test.timeout_seconds * 1000,
      onOutput: (c, stream) => log.write(c, stream),
    });
    log.write(`\n# exit: ${r.exitCode}${r.timedOut ? " (timed out)" : ""}\n`);
    const run: TestRun = { exitCode: r.exitCode, timedOut: r.timedOut, log: log.path };
    if (r.killFailed) run.killFailed = true;
    return run;
  } finally {
    log.close();
  }
}

/** Run the trusted generation command when configured and return its process evidence. */
export async function runGenerate(ctx: GateContext, cwd: string, label: string): Promise<TestRun | undefined> {
  const command = ctx.config.build?.generate;
  if (command) return runCommand(ctx, command, cwd, label);
}

/** Distinguish an interrupted run from a numeric test exit code. */
const runError = (r: TestRun) => r.timedOut || r.exitCode === null;

/** Run the test command in the working tree and classify its exit status. */
export async function testsGate(ctx: GateContext): Promise<GateResult> {
  const started = Date.now();
  const r = await runCommand(ctx, ctx.config.test.command, ctx.root, "gate_tests");
  if (runError(r)) return blocked("tests", "test_run_error", started, { log: r.log });
  return r.exitCode === 0
    ? { name: "tests", outcome: "pass", details: { log: r.log }, durationMs: Date.now() - started }
    : { name: "tests", outcome: "fail", reason: "tests_failed", details: { exitCode: r.exitCode, log: r.log }, durationMs: Date.now() - started };
}

/** Refuse a destination whose existing ancestors (inside the worktree) are links, so writes cannot escape. */
function assertNoLinkedAncestors(projectDir: string, p: string): void {
  let dir = projectDir;
  for (const part of p.split("/").slice(0, -1)) {
    dir = join(dir, part);
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      return; // the rest does not exist yet and will be created as plain directories
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new DevflowError("unsafe_path", `${p}: ${dir} in the rollback worktree is a link or not a directory.`);
    }
  }
}

/** Copy (or delete) project-relative paths from the working tree into the worktree project dir. Deletions first.
 * @param projectDir - Project directory inside the disposable Git worktree.
 * @throws DevflowError on unsupported file types or unsafe destination ancestors.
 */
export function applyPaths(root: string, projectDir: string, paths: string[]): void {
  /** Inspect the source entry without following its final link before ordering copies and deletions. */
  const present = (p: string) => {
    try {
      return lstatSync(join(root, p));
    } catch {
      return undefined;
    }
  };
  const ordered = [...paths.filter((p) => !present(p)), ...paths.filter((p) => present(p))];
  for (const p of ordered) {
    assertNoLinkedAncestors(projectDir, p);
    const src = join(root, p);
    const dst = join(projectDir, p);
    let dstStat;
    try {
      dstStat = lstatSync(dst);
    } catch {
      dstStat = undefined;
    }
    if (dstStat?.isSymbolicLink()) rmSync(dst, { force: true }); // replace the link itself, never follow it
    let st;
    try {
      st = lstatSync(src);
    } catch {
      st = undefined;
    }
    if (!st) {
      rmSync(dst, { force: true, recursive: true });
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new DevflowError("unsupported_change", `${p} is not a regular file; the rollback gate only copies regular files.`);
    }
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
}

/** Decide whether the failing tests-only exit matches the project's accepted red exit codes. */
function isRed(config: Config, r: TestRun): boolean {
  if (r.exitCode === 0 || r.exitCode === null) return false;
  return config.test.red_exit_codes ? config.test.red_exit_codes.includes(r.exitCode) : true;
}

/**
 * Test the clean base, changed tests alone and the full change in a disposable Git worktree.
 * @returns The gate outcome with evidence from the isolated rollback run.
 */
export async function rollbackGate(ctx: GateContext): Promise<GateResult> {
  const started = Date.now();
  const pre = precheck("rollback", ctx, started);
  if (pre) return pre;
  const changes = changeSet(ctx.root, ctx.task.base!);
  const tests = changes.filter((p) => matchesAny(p, ctx.config.test.paths));
  const prod = changes.filter((p) => !matchesAny(p, ctx.config.test.paths));
  if (!tests.length) return { name: "rollback", outcome: "fail", reason: "no_tests", durationMs: Date.now() - started };

  const statusBefore = git(ctx.root, ["status", "--porcelain", "-z"]).stdout;
  let wt: { path: string; projectDir: string } | undefined;
  const logs: string[] = [];
  let result: GateResult;
  try {
    wt = addWorktree(ctx.root, ctx.task.base!);
    const setup = ctx.config.test.setup;
    /** Run a rollback phase in the disposable checkout and collect its log. */
    const step = async (command: string, label: string) => {
      const r = await runCommand(ctx, command, wt!.projectDir, label);
      logs.push(r.log);
      return r;
    };

    /** Refresh derived files in the rollback checkout before testing a changed snapshot. */
    const regenerate = async () => {
      const r = await runGenerate(ctx, wt!.projectDir, "gate_rollback_generate");
      if (!r) return;
      logs.push(r.log);
      if (r.exitCode !== 0 || r.timedOut) return blocked("rollback", "generate_failed", started, { logs });
    };

    result = await (async (): Promise<GateResult> => {
      if (setup) {
        const s = await step(setup, "gate_rollback_setup");
        if (s.exitCode !== 0) return blocked("rollback", "setup_failed", started, { logs });
      }
      const baseline = await step(ctx.config.test.command, "gate_rollback_baseline");
      if (runError(baseline)) return blocked("rollback", "test_run_error", started, { logs });
      if (baseline.exitCode !== 0) return blocked("rollback", "baseline_failed", started, { logs });

      applyPaths(ctx.root, wt!.projectDir, tests);
      const testsGenerateFailure = await regenerate();
      if (testsGenerateFailure) return testsGenerateFailure;
      const red = await step(ctx.config.test.command, "gate_rollback_tests_only");
      if (runError(red)) return blocked("rollback", "test_run_error", started, { logs });
      if (red.exitCode === 0) {
        return { name: "rollback", outcome: "fail", reason: "tests_check_nothing", details: { tests, logs }, durationMs: Date.now() - started };
      }
      if (!isRed(ctx.config, red)) return blocked("rollback", "unexpected_exit_code", started, { exitCode: red.exitCode, logs });

      applyPaths(ctx.root, wt!.projectDir, prod);
      if (setup && changes.some((p) => matchesAny(p, ctx.config.test.setup_inputs))) {
        const s2 = await step(setup, "gate_rollback_setup");
        if (s2.exitCode !== 0) return blocked("rollback", "setup_failed", started, { logs });
      }
      const fullGenerateFailure = await regenerate();
      if (fullGenerateFailure) return fullGenerateFailure;
      const green = await step(ctx.config.test.command, "gate_rollback_full");
      if (runError(green)) return blocked("rollback", "test_run_error", started, { logs });
      if (green.exitCode !== 0) {
        return { name: "rollback", outcome: "fail", reason: "tests_fail_with_change", details: { logs }, durationMs: Date.now() - started };
      }
      return { name: "rollback", outcome: "pass", details: { tests, logs }, durationMs: Date.now() - started };
    })();
  } catch (e) {
    result = blocked("rollback", e instanceof DevflowError ? e.reason : "rollback_error", started, { message: (e as Error).message, logs });
  } finally {
    const pending = wt?.path;
    if (pending) {
      let removed = false;
      try {
        removed = removeWorktree(ctx.root, pending);
      } catch {
        removed = false;
      }
      if (!removed) return blocked("rollback", "cleanup_failed", started, { path: pending, logs });
    }
  }
  const statusAfter = git(ctx.root, ["status", "--porcelain", "-z"]).stdout;
  if (statusAfter !== statusBefore) {
    return blocked("rollback", "working_tree_changed", started, { logs });
  }
  return result;
}

/** Run one gate; any operational error becomes `blocked`, never an exception. */
export async function runGate(name: GateName, ctx: GateContext): Promise<GateResult> {
  const started = Date.now();
  try {
    switch (name) {
      case "zone":
        return zoneGate(ctx);
      case "tests":
        return await testsGate(ctx);
      case "rollback":
        return await rollbackGate(ctx);
    }
  } catch (e) {
    return blocked(name, e instanceof DevflowError ? e.reason : "gate_error", started, { message: (e as Error).message });
  }
}

/** zone → tests → rollback, stopping at the first non-pass. */
export async function runAllGates(ctx: GateContext): Promise<{ results: GateResult[]; skipped: GateName[] }> {
  const results: GateResult[] = [];
  for (const name of GATE_NAMES) {
    const r = await runGate(name, ctx);
    results.push(r);
    if (r.outcome !== "pass") {
      return { results, skipped: GATE_NAMES.slice(GATE_NAMES.indexOf(name) + 1) };
    }
  }
  return { results, skipped: [] };
}
