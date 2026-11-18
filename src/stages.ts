import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";
import { DEVFLOW_DIR } from "./config.js";
import { DevflowError } from "./errors.js";
import { checkDesign } from "./artifacts.js";
import { applyPaths, gateConfig, runAllGates, runCommand, type GateResult } from "./gates.js";
import { addWorktree, changeSet, removeWorktree } from "./git.js";
import { nextStage, roleFor, transition, type Event, type NextInfo, type Stage, type TaskState } from "./lifecycle.js";
import { block, composePrompt, loadTemplate, section, type PromptStage } from "./prompts.js";
import { runRole, type RunResult } from "./runners.js";
import { changeFileHashes, changeFiles, changeFolder, planDigest, snapshotDigest } from "./snapshot.js";
import { loadTask, saveTask } from "./store.js";

export interface StageIo {
  now: () => string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface StageReport {
  stage: Stage | "invalidate";
  outcome: string;
  reason?: string;
  details?: unknown;
  next: NextInfo;
}

const runsDir = (root: string, id: string) => join(root, DEVFLOW_DIR, "runs", id);
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");

function record(root: string, task: TaskState, event: Event, config: Config, io: StageIo): TaskState {
  const current = loadTask(root, task.id);
  if (current.updatedAt !== task.updatedAt) {
    throw new DevflowError("state_changed", `Task ${task.id} changed while the stage was running; result not recorded.`);
  }
  const next = transition(current, event, config, io.now());
  saveTask(root, next);
  return next;
}

function setZone(root: string, task: TaskState, zone: string[], io: StageIo): TaskState {
  const t = loadTask(root, task.id);
  t.zone = zone;
  t.updatedAt = io.now();
  t.history.push({ at: t.updatedAt, kind: "zone", reason: zone.join(", ") });
  saveTask(root, t);
  return t;
}

/** The living specs and the change folder as prompt context. */
function livingSpecs(root: string): string {
  const dir = join(root, "openspec", "specs");
  if (!existsSync(dir)) return "";
  const files = changeFiles(root, "../specs").map((f) => `- openspec/specs/${f}`);
  return files.join("\n");
}

function changeContext(root: string, id: string, include: (f: string) => boolean): string {
  const dir = changeFolder(root, id);
  return changeFiles(root, id)
    .filter(include)
    .map((f) => block(`openspec/changes/${id}/${f}`, read(join(dir, f))))
    .join("");
}

function verdictOf(text: string): "pass" | "rework" | "human" | undefined {
  const first = text.replace(/^﻿/, "").split(/\r?\n/).find((l) => l.trim())?.trim().toUpperCase() ?? "";
  return first === "VERDICT: PASS" ? "pass" : first === "VERDICT: REWORK" ? "rework" : first === "VERDICT: HUMAN" ? "human" : undefined;
}

function gatesSummary(task: TaskState): string {
  const last = [...task.history].reverse().find((h) => h.kind === "gates");
  return last ? `${last.outcome}${last.results ? `: ${last.results}` : ""}` : "";
}

/** Record the result of all gates; shared by `devflow gate` and the run loop. */
export async function runGatesStage(root: string, task: TaskState, workingConfig: Config, io: StageIo): Promise<{ task: TaskState; results: GateResult[]; skipped: string[]; configSource: string }> {
  const { config, source } = gateConfig(root, task.base, workingConfig);
  const { results, skipped } = await runAllGates({ root, task, config, parentEnv: io.env });
  const last = results[results.length - 1]!;
  const summary = results.map((r) => `${r.name}:${r.outcome}${r.reason ? `(${r.reason})` : ""}`).join(", ");
  let event: Event;
  if (last.outcome === "pass") {
    event = { kind: "gates", outcome: "pass", results: summary, snapshot: snapshotDigest(root, task.base!, config) };
  } else {
    event = { kind: "gates", outcome: last.outcome, gate: last.name, results: summary, ...(last.reason ? { reason: last.reason } : {}) };
  }
  return { task: record(root, task, event, config, io), results, skipped, configSource: source };
}

function role(stage: Stage, task: TaskState, config: Config) {
  const r = roleFor(stage, task.tier, config);
  if (!r) throw new DevflowError("unknown_role", `No role configured for ${stage}.`);
  return r;
}

async function runModel(
  root: string,
  task: TaskState,
  config: Config,
  io: StageIo,
  stage: PromptStage,
  roleStage: Stage,
  context: string,
  write: string[],
  expect: string[],
  extra: { bash?: string[]; cwd?: string; round?: number; previousVerdict?: string } = {},
): Promise<RunResult> {
  const prompt = composePrompt(loadTemplate(root, stage), {
    id: task.id,
    description: task.description,
    ...(task.tracker ? { tracker: task.tracker } : {}),
    language: config.language,
    outputs: expect.length ? expect.join(", ") : write.join(", "),
    context,
    testCommand: config.test.command,
    ...(extra.round ? { round: extra.round } : {}),
    ...(extra.previousVerdict ? { previousVerdict: extra.previousVerdict } : {}),
  });
  return runRole({
    root,
    roleName: stage,
    role: role(roleStage, task, config),
    config,
    prompt,
    write,
    bash: extra.bash ?? [],
    expect,
    timeoutMs: io.timeoutMs ?? 1_800_000,
    task: task.id,
    parentEnv: io.env,
    savePrompt: true,
    ...(extra.cwd ? { cwd: extra.cwd } : {}),
  });
}

/** Run the task's next stage once and record its outcome. Returns undefined when nothing is runnable. */
export async function runNextStage(root: string, workingConfig: Config, id: string, io: StageIo): Promise<StageReport | undefined> {
  let task = loadTask(root, id);
  const config = workingConfig;
  const next = nextStage(task, config);
  if (!next.stage) return undefined;
  const stage = next.stage;
  const report = (outcome: string, t: TaskState, reason?: string, details?: unknown): StageReport => ({
    stage,
    outcome,
    ...(reason ? { reason } : {}),
    ...(details === undefined ? {} : { details }),
    next: nextStage(t, config),
  });

  // An approved plan must not change afterwards.
  if (task.tier !== "small" && task.planDigest && ["implement", "gates", "verify"].includes(stage)) {
    if (planDigest(root, id) !== task.planDigest) {
      task = record(root, task, { kind: "invalidate", to: "approval", reason: "plan_changed" }, config, io);
      return { stage: "invalidate", outcome: "plan_changed", next: nextStage(task, config) };
    }
  }

  switch (stage) {
    case "explore": {
      const out = `.devflow/runs/${id}/facts.md`;
      const ctx = block("Living specs (read as needed)", livingSpecs(root));
      const r = await runModel(root, task, config, io, "explore", "explore", ctx, [out], [out]);
      task = record(root, task, { kind: "complete", stage, outcome: r.ok ? "ok" : "fail" }, config, io);
      return report(r.ok ? "ok" : "fail", task, r.ok ? undefined : "run_failed", r);
    }

    case "design": {
      const before = changeFileHashes(root, id);
      const folder = `openspec/changes/${id}`;
      const ctx = block("Exploration notes", read(join(runsDir(root, id), "facts.md"))) + block("Living specs (read as needed)", livingSpecs(root));
      const r = await runModel(root, task, config, io, "design", "design", ctx, [`${folder}/**`], ["proposal.md", "design.md", "tasks.md"].map((f) => `${folder}/${f}`));
      if (!r.ok) {
        task = record(root, task, { kind: "complete", stage, outcome: "fail" }, config, io);
        return report("fail", task, "run_failed", r);
      }
      const check = await checkDesign(root, id, config, before);
      if (!check.ok) {
        task = record(root, task, { kind: "complete", stage, outcome: "fail" }, config, io);
        return report("fail", task, check.reason, check.details);
      }
      task = setZone(root, task, check.zone!, io);
      task = record(root, task, { kind: "complete", stage, outcome: "ok" }, config, io);
      return report("ok", task);
    }

    case "implement": {
      const small = task.tier === "small";
      const tasksMd = `openspec/changes/${id}/tasks.md`;
      const zone = task.zone?.length ? task.zone : small ? ["**"] : [];
      if (!zone.length) throw new DevflowError("no_zone", `Task ${id} has no impact zone; approve a design or set one with "devflow zone".`);
      const ctx = small
        ? ""
        : changeContext(root, id, () => true) + block("Impact zone", zone.map((z) => `- ${z}`).join("\n"));
      const write = small ? zone : [...zone, tasksMd];
      const r = await runModel(root, task, config, io, small ? "small" : "implement", "implement", ctx, write, [], { bash: [config.test.command] });
      task = record(root, task, { kind: "complete", stage, outcome: r.ok ? "ok" : "fail" }, config, io);
      return report(r.ok ? "ok" : "fail", task, r.ok ? undefined : "run_failed", r);
    }

    case "gates": {
      const g = await runGatesStage(root, task, config, io);
      const last = g.results[g.results.length - 1]!;
      return report(last.outcome, g.task, last.reason, { results: g.results, skipped: g.skipped, configSource: g.configSource });
    }

    case "verify":
      return runVerify(root, task, config, io, report);
  }
}

async function runVerify(
  root: string,
  task: TaskState,
  workingConfig: Config,
  io: StageIo,
  report: (outcome: string, t: TaskState, reason?: string, details?: unknown) => StageReport,
): Promise<StageReport> {
  const id = task.id;
  const { config } = gateConfig(root, task.base, workingConfig);
  const snap = snapshotDigest(root, task.base!, config);
  if (!task.gatesSnapshot || snap !== task.gatesSnapshot) {
    const t = record(root, task, { kind: "invalidate", to: "gates", reason: "snapshot_changed" }, workingConfig, io);
    return { stage: "invalidate", outcome: "snapshot_changed", next: nextStage(t, workingConfig) };
  }

  const dir = runsDir(root, id);
  const verdictPath = join(dir, "verdict.md");
  const round = task.history.filter((h) => h.kind === "complete" && h.stage === "verify").length + 1;
  let previous: string | undefined;
  if (existsSync(verdictPath)) {
    previous = read(verdictPath);
    renameSync(verdictPath, join(dir, `verdict-round${round - 1}.md`));
  }

  const folder = changeFolder(root, id);
  const deltas = changeContext(root, id, (f) => f.startsWith("specs/"));
  const ctx =
    deltas +
    block(`openspec/changes/${id}/tasks.md`, read(join(folder, "tasks.md"))) +
    block("Test plan (from the design)", section(read(join(folder, "design.md")), "Test plan")) +
    block("Changed files", changeSet(root, task.base!).map((p) => `- ${p}`).join("\n")) +
    block("Gate results", gatesSummary(task));

  const changes = changeSet(root, task.base!);
  let wt: { path: string; projectDir: string } | undefined;
  let r: RunResult | undefined;
  let failure: string | undefined;
  try {
    wt = addWorktree(root, task.base!);
    applyPaths(root, wt.projectDir, changes);
    rmSync(join(wt.projectDir, "openspec", "changes", id, "design.md"), { force: true });
    rmSync(join(wt.projectDir, DEVFLOW_DIR), { recursive: true, force: true });
    if (config.test.setup) {
      const s = await runCommand({ root, task, config, parentEnv: io.env }, config.test.setup, wt.projectDir, "verify_setup");
      if (s.exitCode !== 0) failure = "verify_setup_failed";
    }
    if (!failure) {
      r = await runModel(root, task, config, io, "verify", "verify", ctx, [".devflow-verdict.md"], [".devflow-verdict.md"], {
        cwd: wt.projectDir,
        round,
        ...(previous ? { previousVerdict: previous } : {}),
        bash: [config.test.command],
      });
      const produced = join(wt.projectDir, ".devflow-verdict.md");
      if (existsSync(produced)) {
        mkdirSync(dirname(verdictPath), { recursive: true });
        copyFileSync(produced, verdictPath);
      }
      if (!r.ok) failure = "verify_run_failed";
    }
  } catch (e) {
    failure = e instanceof DevflowError ? e.reason : "verify_error";
  } finally {
    if (wt && !removeWorktree(root, wt.path)) failure = failure ?? "cleanup_failed";
  }

  const verdict = failure ? undefined : verdictOf(read(verdictPath));
  if (!verdict) {
    const t = record(root, task, { kind: "complete", stage: "verify", outcome: "human" }, workingConfig, io);
    return report("human", t, failure ?? "unreadable_verdict", r);
  }
  if (verdict === "pass" && snapshotDigest(root, task.base!, config) !== snap) {
    const t = record(root, task, { kind: "invalidate", to: "gates", reason: "snapshot_changed" }, workingConfig, io);
    return { stage: "invalidate", outcome: "snapshot_changed", next: nextStage(t, workingConfig) };
  }
  const event: Event = verdict === "pass"
    ? { kind: "complete", stage: "verify", outcome: "pass", evidence: snap }
    : { kind: "complete", stage: "verify", outcome: verdict };
  const t = record(root, task, event, workingConfig, io);
  return report(verdict, t, undefined, { verdict: verdictPath, round });
}

/** Run stages until a human is needed, a stage fails, or the task is done. */
export async function runLoop(root: string, config: Config, id: string, io: StageIo, opts: { once?: boolean; onStage?: (r: StageReport) => void } = {}): Promise<StageReport[]> {
  const reports: StageReport[] = [];
  for (;;) {
    const r = await runNextStage(root, config, id, io);
    if (!r) break;
    reports.push(r);
    opts.onStage?.(r);
    if (opts.once) break;
    if (r.outcome === "fail" || r.outcome === "blocked" || r.outcome === "human") break;
    if (!r.next.stage) break;
  }
  return reports;
}
