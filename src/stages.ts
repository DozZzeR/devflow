import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";
import { DEVFLOW_DIR } from "./config.js";
import { DevflowError } from "./errors.js";
import { checkDesign } from "./artifacts.js";
import { applyPaths, gateConfig, runAllGates, runCommand, type GateResult } from "./gates.js";
import { addWorktree, changeSet, detachWorktreeGit, removeDetached } from "./git.js";
import { nextStage, roleFor, transition, type Event, type NextInfo, type Stage, type TaskState } from "./lifecycle.js";
import { block, composePrompt, loadTemplate, section, type PromptStage } from "./prompts.js";
import { runRole, type RunResult } from "./runners.js";
import { changeFileHashes, changeFiles, changeFolder, planDigest, snapshotDigest } from "./snapshot.js";
import { loadTask, saveTask } from "./store.js";
import { parseBlocked, parsePlanConflict, runDelegatedReview } from "./review.js";

export interface StageIo {
  now: () => string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface StageReport {
  stage: Stage | "invalidate" | "review";
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

/**
 * The verdict from claude's structured JSON answer, from its "VERDICT:" line on. Only the JSON "result" is
 * read: a plain log may echo the prompt, which can quote an earlier verdict.
 */
function verdictFromAnswer(log: string): string | undefined {
  for (const line of log.split(/\r?\n/).reverse()) {
    const t = line.trim();
    if (!t.startsWith("{") || !t.includes('"result"')) continue;
    try {
      const result = (JSON.parse(t) as { result?: unknown }).result;
      if (typeof result !== "string") continue;
      const lines = result.split(/\r?\n/);
      const at = lines.findIndex((l) => verdictOf(l.replace(/^\*\*|\*\*$/g, "")) !== undefined);
      if (at >= 0) return [lines[at]!.replace(/^\*\*|\*\*$/g, ""), ...lines.slice(at + 1)].join("\n").trim() + "\n";
    } catch {
      /* not JSON */
    }
  }
  return undefined;
}

/** The newest saved verdict-round<N>.md with N <= upTo. */
function lastSavedVerdict(dir: string, upTo: number): string | undefined {
  for (let n = upTo; n >= 1; n--) {
    const p = join(dir, `verdict-round${n}.md`);
    if (existsSync(p)) return read(p);
  }
  return undefined;
}

function gatesSummary(task: TaskState): string {
  const last = [...task.history].reverse().find((h) => h.kind === "gates");
  return last ? `${last.outcome}${last.results ? `: ${last.results}` : ""}` : "";
}

/** Record the result of all gates; shared by `devflow gate` and the run loop. */
export async function runGatesStage(root: string, task: TaskState, workingConfig: Config, io: StageIo): Promise<{ task: TaskState; results: GateResult[]; skipped: string[]; configSource: string }> {
  const { config, source } = gateConfig(root, task.base, workingConfig);
  const before = task.base ? snapshotDigest(root, task.base, config) : undefined;
  const { results, skipped } = await runAllGates({ root, task, config, parentEnv: io.env });
  let last = results[results.length - 1]!;
  if (last.outcome === "pass" && before !== snapshotDigest(root, task.base!, config)) {
    // The files changed while the gates were running: what passed is not what is on disk now.
    last = { ...last, outcome: "blocked", reason: "tree_changed_during_gates" };
    results[results.length - 1] = last;
  }
  const summary = results.map((r) => `${r.name}:${r.outcome}${r.reason ? `(${r.reason})` : ""}`).join(", ");
  let event: Event;
  if (last.outcome === "pass") {
    event = { kind: "gates", outcome: "pass", results: summary, snapshot: before! };
  } else {
    event = { kind: "gates", outcome: last.outcome, gate: last.name, results: summary, ...(last.reason ? { reason: last.reason } : {}) };
  }
  const recorded = record(root, task, event, config, io);
  saveGatesFailure(root, task.id, last.outcome === "pass" ? undefined : results);
  return { task: recorded, results, skipped, configSource: source };
}

const GATES_FAILURE = "gates-failure.md";
const LOG_TAIL_LINES = 80;

function tail(text: string, lines: number): string {
  const all = text.split(/\r?\n/);
  return (all.length > lines ? ["[...]", ...all.slice(-lines)] : all).join("\n").trim();
}

/** Keep what the implementer needs to fix a gate failure; a pass clears it. */
function saveGatesFailure(root: string, id: string, results: GateResult[] | undefined): void {
  const path = join(runsDir(root, id), GATES_FAILURE);
  if (!results) {
    rmSync(path, { force: true });
    return;
  }
  const parts = results
    .filter((r) => r.outcome !== "pass")
    .map((r) => {
      const { log, logs, ...rest } = (r.details ?? {}) as Record<string, unknown>;
      const files = [log, ...(Array.isArray(logs) ? logs : [])].filter((l): l is string => typeof l === "string");
      const extra = Object.keys(rest).length ? `\nDetails: ${JSON.stringify(rest)}` : "";
      const logText = files.length ? `\nLog tail:\n${tail(read(files[files.length - 1]!), LOG_TAIL_LINES)}` : "";
      return `Gate ${r.name}: ${r.outcome}${r.reason ? ` (${r.reason})` : ""}${extra}${logText}`;
    });
  writeFileSync(path, parts.join("\n\n") + "\n");
}

/** Why the previous implement attempt was sent back: the last REWORK verdict and the last gate failure, if still current. */
function reworkFeedback(root: string, task: TaskState): string {
  const lastVerify = [...task.history].reverse().find((h) => h.kind === "complete" && h.stage === "verify");
  const lastGates = [...task.history].reverse().find((h) => h.kind === "gates");
  const dir = runsDir(root, task.id);
  const verdict = lastVerify?.outcome === "rework" ? read(join(dir, "verdict.md")) : "";
  const gates = lastGates && lastGates.outcome !== "pass" ? read(join(dir, GATES_FAILURE)) : "";
  return (
    block("Verify verdict on the previous attempt (fix every high and medium finding)", verdict) +
    block("Gate failure on the previous attempt (make the gates pass)", gates)
  );
}

function role(stage: Stage, task: TaskState, config: Config) {
  const r = roleFor(stage, task.tier, config);
  if (!r) throw new DevflowError("unknown_role", `No role configured for ${stage}.`);
  return r;
}

async function runModel(...a: Parameters<typeof runModelRaw>): Promise<RunResult> {
  try {
    return await runModelRaw(...a);
  } catch (e) {
    const [, task, config, , , roleStage] = a;
    const r = roleFor(roleStage, task.tier, config);
    return {
      ok: false,
      role: a[4],
      runner: r?.runner ?? "command",
      model: r?.model ?? "",
      exitCode: null,
      durationMs: 0,
      timedOut: false,
      missingOutputs: [],
      scope: "advisory",
      apiKeyEnv: "stripped",
      log: "",
      error: e instanceof DevflowError ? e.reason : (e as Error).message,
    } as RunResult;
  }
}

async function runModelRaw(
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
    outputs: `you may write ${write.join(", ")}` + (expect.length ? `; you must produce ${expect.join(", ")}` : ""),
    context,
    testCommand: config.test.command,
    ...(extra.round ? { round: extra.round } : {}),
    ...(extra.previousVerdict ? { previousVerdict: extra.previousVerdict } : {}),
  });
  const mustHave =
    extra.round && extra.round >= 2 && !prompt.includes("ONLY high-severity")
      ? `\n\nThis is round ${extra.round}. Report ONLY high-severity findings and regressions of findings from the previous verdict below.\n\n## Previous verdict\n\n${extra.previousVerdict ?? ""}\n`
      : "";
  return runRole({
    root,
    roleName: stage,
    role: role(roleStage, task, config),
    config,
    prompt: prompt + mustHave,
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
  if (!next.stage) {
    if (next.reason === "awaiting_plan_approval" && task.approval === "model") {
      return (await runDelegatedReview(root, config, id, io)) as StageReport;
    }
    return undefined;
  }
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
    if (planDigest(root, id, task.planRevision ?? 1) !== task.planDigest) {
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
      const rejections = task.history.filter((h) => h.kind === "reject").map((h) => `- ${h.reason ?? ""}`).join("\n");
      const ctx =
        block("Exploration notes", read(join(runsDir(root, id), "facts.md"))) +
        block("Living specs (read as needed)", livingSpecs(root)) +
        block("Reviewer feedback on earlier versions of this plan (address every point)", rejections) +
        (rejections ? block("Current plan files (revise them)", changeContext(root, id, () => true)) + reworkFeedback(root, task) : "");
      // A first design must produce every file fresh. A revision after a rejection may keep files that
      // were fine, but must change the plan.
      const revision = rejections.length > 0;
      const filesBefore = revision ? planDigest(root, id) : "";
      const required = revision ? [] : ["proposal.md", "design.md", "tasks.md"].map((f) => `${folder}/${f}`);
      const r = await runModel(root, task, config, io, "design", "design", ctx, [`${folder}/**`], required);
      if (!r.ok) {
        task = record(root, task, { kind: "complete", stage, outcome: "fail" }, config, io);
        return report("fail", task, "run_failed", r);
      }
      const unchanged = revision && planDigest(root, id) === filesBefore;
      const check = await checkDesign(root, id, config, revision ? undefined : before);
      if (!check.ok) {
        task = record(root, task, { kind: "complete", stage, outcome: "fail" }, config, io);
        return report("fail", task, check.reason, check.details);
      }
      task = setZone(root, task, check.zone!, io);
      task = record(root, task, { kind: "complete", stage, outcome: "ok", byRun: true }, config, io);
      return report("ok", task, unchanged ? "plan_files_unchanged" : undefined, { revision: task.planRevision ?? 1 });
    }

    case "implement": {
      const small = task.tier === "small";
      const tasksMd = `openspec/changes/${id}/tasks.md`;
      const zone = task.zone?.length ? task.zone : small ? ["**"] : [];
      if (!zone.length) throw new DevflowError("no_zone", `Task ${id} has no impact zone; approve a design or set one with "devflow zone".`);
      const ctx =
        (small ? "" : changeContext(root, id, () => true) + block("Impact zone", zone.map((z) => `- ${z}`).join("\n"))) +
        reworkFeedback(root, task);
      const write = small ? zone : [...zone, tasksMd];
      const r = await runModel(root, task, config, io, small ? "small" : "implement", "implement", ctx, write, [], { bash: [config.test.command] });
      const answer = r.ok && r.log ? read(r.log) : "";
      const blocked = answer ? parseBlocked(answer) : undefined;
      if (blocked) {
        task = record(root, task, { kind: "blocked", stage: "implement", reason: blocked }, config, io);
        return report("blocked", task, blocked, r);
      }
      const conflict = answer && !small ? parsePlanConflict(answer) : undefined;
      if (conflict) {
        task = record(root, task, { kind: "plan_conflict", reason: `implementer: ${conflict}` }, config, io);
        return report("plan_conflict", task, conflict, r);
      }
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
  } else {
    // The last round produced no verdict (it failed): narrow against the last verdict that exists,
    // or a later round would drop the known findings it is told to re-check.
    previous = lastSavedVerdict(dir, round - 1);
  }

  const folder = changeFolder(root, id);
  const deltas = changeContext(root, id, (f) => f.startsWith("specs/"));
  const changes = changeSet(root, task.base!);
  const ctx =
    deltas +
    block(`openspec/changes/${id}/tasks.md`, read(join(folder, "tasks.md"))) +
    block("Test plan (from the design)", section(read(join(folder, "design.md")), "Test plan")) +
    block("Changed files", changes.map((p) => `- ${p}`).join("\n")) +
    block("Gate results", gatesSummary(task));

  let wt: { path: string; projectDir: string } | undefined;
  let r: RunResult | undefined;
  let failure: string | undefined;
  try {
    wt = addWorktree(root, task.base!);
    detachWorktreeGit(wt.path);
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
      // Copy only a regular file: a link planted by the verifier must not make devflow read outside the copy.
      if (existsSync(produced) && lstatSync(produced).isFile()) {
        mkdirSync(dirname(verdictPath), { recursive: true });
        copyFileSync(produced, verdictPath);
      } else if (existsSync(produced)) {
        failure = "unsafe_verdict";
      }
      if (!r.ok) {
        // A verifier that answered with the verdict instead of writing the file still gave one.
        const answered = !existsSync(produced) && r.exitCode === 0 && !r.timedOut && r.missingOutputs.length === 1 && r.log
          ? verdictFromAnswer(read(r.log))
          : undefined;
        if (answered) {
          mkdirSync(dirname(verdictPath), { recursive: true });
          writeFileSync(verdictPath, answered);
        } else {
          failure = "verify_run_failed";
        }
      }
    }
  } catch (e) {
    failure = e instanceof DevflowError ? e.reason : "verify_error";
  } finally {
    if (wt && !removeDetached(root, wt.path)) failure = failure ?? "cleanup_failed";
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
    if (r.outcome === "fail" || r.outcome === "blocked" || r.outcome === "human" || r.outcome === "stale") break;
    const delegatedApproval = r.next.reason === "awaiting_plan_approval" && loadTask(root, id).approval === "model";
    if (!r.next.stage && !delegatedApproval) break;
  }
  return reports;
}
