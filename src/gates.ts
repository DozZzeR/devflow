import { copyFileSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";
import { DevflowError } from "./errors.js";
import { addWorktree, changeSet, git, removeWorktree, repoInfo } from "./git.js";
import { matchesAny } from "./glob.js";
import type { GateOutcome, TaskState } from "./lifecycle.js";
import { openLog } from "./logs.js";
import { launchShell } from "./proc.js";
import { outsideZone } from "./zone.js";

export const GATE_NAMES = ["zone", "tests", "rollback"] as const;
export type GateName = (typeof GATE_NAMES)[number];

export interface GateResult {
  name: GateName;
  outcome: GateOutcome;
  reason?: string;
  details?: unknown;
  durationMs: number;
  warnings?: string[];
}

export interface GateContext {
  root: string;
  task: TaskState;
  config: Config;
  parentEnv?: NodeJS.ProcessEnv;
}

const blocked = (name: GateName, reason: string, started: number, details?: unknown): GateResult => ({
  name,
  outcome: "blocked",
  reason,
  durationMs: Date.now() - started,
  ...(details === undefined ? {} : { details }),
});

/** Common preconditions: git present and a base recorded. */
function precheck(name: GateName, ctx: GateContext, started: number): GateResult | undefined {
  if (!repoInfo(ctx.root)) return blocked(name, "no_git", started);
  if (!ctx.task.base) return blocked(name, "no_base", started);
  return undefined;
}

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
  const outside = outsideZone(changes, zone);
  return outside.length
    ? { name: "zone", outcome: "fail", reason: "outside_zone", details: { outside }, durationMs: Date.now() - started }
    : { name: "zone", outcome: "pass", details: { changed: changes.length }, durationMs: Date.now() - started };
}

interface TestRun {
  exitCode: number | null;
  timedOut: boolean;
  killFailed?: boolean;
  log: string;
}

async function runCommand(ctx: GateContext, command: string, cwd: string, label: string): Promise<TestRun> {
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

const runError = (r: TestRun) => r.timedOut || r.exitCode === null;

export async function testsGate(ctx: GateContext): Promise<GateResult> {
  const started = Date.now();
  const r = await runCommand(ctx, ctx.config.test.command, ctx.root, "gate_tests");
  if (runError(r)) return blocked("tests", "test_run_error", started, { log: r.log });
  return r.exitCode === 0
    ? { name: "tests", outcome: "pass", details: { log: r.log }, durationMs: Date.now() - started }
    : { name: "tests", outcome: "fail", reason: "tests_failed", details: { exitCode: r.exitCode, log: r.log }, durationMs: Date.now() - started };
}

/** Copy (or delete) project-relative paths from the working tree into the worktree project dir. */
function applyPaths(root: string, projectDir: string, paths: string[]): void {
  for (const p of paths) {
    const src = join(root, p);
    const dst = join(projectDir, p);
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

function isRed(config: Config, r: TestRun): boolean {
  if (r.exitCode === 0 || r.exitCode === null) return false;
  return config.test.red_exit_codes ? config.test.red_exit_codes.includes(r.exitCode) : true;
}

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
    const step = async (command: string, label: string) => {
      const r = await runCommand(ctx, command, wt!.projectDir, label);
      logs.push(r.log);
      return r;
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
      const red = await step(ctx.config.test.command, "gate_rollback_tests_only");
      if (runError(red)) return blocked("rollback", "test_run_error", started, { logs });
      if (red.exitCode === 0) {
        return { name: "rollback", outcome: "fail", reason: "tests_check_nothing", details: { tests, logs }, durationMs: Date.now() - started };
      }
      if (!isRed(ctx.config, red)) return blocked("rollback", "unexpected_exit_code", started, { exitCode: red.exitCode, logs });

      applyPaths(ctx.root, wt!.projectDir, prod);
      if (setup && prod.some((p) => matchesAny(p, ctx.config.test.setup_inputs))) {
        const s2 = await step(setup, "gate_rollback_setup");
        if (s2.exitCode !== 0) return blocked("rollback", "setup_failed", started, { logs });
      }
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
    if (wt && !removeWorktree(ctx.root, wt.path)) {
      return blocked("rollback", "cleanup_failed", started, { path: wt.path, logs });
    }
  }
  const statusAfter = git(ctx.root, ["status", "--porcelain", "-z"]).stdout;
  if (statusAfter !== statusBefore) {
    return blocked("rollback", "working_tree_changed", started, { logs });
  }
  return result;
}

export async function runGate(name: GateName, ctx: GateContext): Promise<GateResult> {
  switch (name) {
    case "zone":
      return zoneGate(ctx);
    case "tests":
      return testsGate(ctx);
    case "rollback":
      return rollbackGate(ctx);
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
