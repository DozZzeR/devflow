/** @file Execute one stage or a run loop and bind artifacts, gate evidence and model outcomes to task state. */

import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";
import { DEVFLOW_DIR } from "./config.js";
import { DevflowError } from "./errors.js";
import type { FocusedScope } from "./focused.js";
import { checkDesign } from "./artifacts.js";
import { applyPaths, gateConfig, runAllGates, runCommand, runGenerate, type GateResult } from "./gates.js";
import { addWorktree, changeSet, detachWorktreeGit, removeDetached, repoInfo } from "./git.js";
import { nextStage, roleFor, transition, type Event, type HistoryEntry, type NextInfo, type Stage, type TaskState } from "./lifecycle.js";
import { block, composePrompt, loadTemplate, section, type PromptStage } from "./prompts.js";
import { runRole, type RunResult } from "./runners.js";
import { changeFileHashes, changeFiles, changeFolder, pathHashes, planDigest, snapshotDigest } from "./snapshot.js";
import { decidedFeedback, planNodes, replaceNode, reviewDecisions } from "./plan-nodes.js";
import { loadTask, saveTask, writeFileAtomic } from "./store.js";
import { parseBlocked, parsePlanConflict, runDelegatedReview } from "./review.js";
import { verificationContext } from "./verify-context.js";

/** Host clock, process environment and optional time budget for stage execution. */
export interface StageIo {
  /** Clock supplying timestamps to persisted transitions. */
  now: () => string;
  /** Environment passed to role and deterministic subprocess adapters. */
  env: NodeJS.ProcessEnv;
  /** Optional per-role timeout override in milliseconds. */
  timeoutMs?: number;
  /** Override removal of the current verify copy for tests. Returns false if the copy remains. */
  removeCopy?: (root: string, path: string) => boolean;
}

/** One emitted stage result with its evidence and successor decision. */
export interface StageReport {
  /** Executed stage or orchestration action such as invalidation or delegated review. */
  stage: Stage | "invalidate" | "review";
  /** Result label consumed by the loop when deciding whether to continue. */
  outcome: string;
  /** Machine-readable cause when the stage stopped or rerouted. */
  reason?: string;
  /** Optional runner output, gate evidence or artifact references. */
  details?: unknown;
  /** Next-stage decision derived from the recorded state. */
  next: NextInfo;
}

/** Resolve the run directory for this task's role artifacts. */
const runsDir = (root: string, id: string) => join(root, DEVFLOW_DIR, "runs", id);
/** Read an optional Markdown artifact, using empty text when absent. */
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");

/**
 * Re-read the task, reject a changed timestamp and persist a validated lifecycle transition.
 * For an escalation revision, save the triggering runner's evidence before publishing the transition.
 * @throws DevflowError when another update changed the task timestamp before this result was recorded.
 */
function record(root: string, task: TaskState, event: Event, config: Config, io: StageIo, evidence?: string): TaskState {
  const current = loadTask(root, task.id);
  if (current.updatedAt !== task.updatedAt) {
    throw new DevflowError("state_changed", `Task ${task.id} changed while the stage was running; result not recorded.`);
  }
  const next = transition(current, event, config, io.now());
  const escalation = next.history.at(-1);
  if (evidence && escalation?.kind === "escalate" && /^revision \d+$/.test(escalation.results ?? "")) {
    const trigger = next.history.at(-2)!;
    writeFileAtomic(escalationEvidencePath(root, task.id, next.history.length - 1, trigger.stage), evidence);
  }
  saveTask(root, next);
  return next;
}

/** Record the design's implementation globs and append a zone history entry. */
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

/** Inline selected OpenSpec artifacts as named sections for a role. */
function changeContext(root: string, id: string, include: (f: string) => boolean): string {
  const dir = changeFolder(root, id);
  return changeFiles(root, id)
    .filter(include)
    .map((f) => block(`openspec/changes/${id}/${f}`, read(join(dir, f))))
    .join("");
}

/** Recognize PASS, REWORK or HUMAN on the first nonblank verdict line. */
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
function lastSavedVerdict(dir: string, upTo: number): { round: number; text: string } | undefined {
  for (let n = upTo; n >= 1; n--) {
    const p = join(dir, `verdict-round${n}.md`);
    if (existsSync(p)) return { round: n, text: read(p) };
  }
  return undefined;
}

/** Retrieve the recorded gate results for the verification prompt. */
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
  const feedback = last.outcome === "pass" ? "" : formatGatesFailure(results);
  const recorded = record(root, task, event, config, io, feedback);
  const failurePath = join(runsDir(root, task.id), GATES_FAILURE);
  if (feedback) writeFileSync(failurePath, feedback);
  else rmSync(failurePath, { force: true });
  return { task: recorded, results, skipped, configSource: source };
}

/** Task-local feedback artifact for the last failed or blocked gate run. */
const GATES_FAILURE = "gates-failure.md";
/** Task-local feedback artifact for a failed implementation generation command. */
const GENERATE_FAILURE = "generate-failure.md";
/** Maximum recent command output lines included in rework feedback. */
const LOG_TAIL_LINES = 80;

/** Extract a bounded tail of command output for the next implementation attempt. */
function tail(text: string, lines: number): string {
  const all = text.split(/\r?\n/);
  return (all.length > lines ? ["[...]", ...all.slice(-lines)] : all).join("\n").trim();
}

/** Render failed gates and their bounded command evidence for the next attempt. */
function formatGatesFailure(results: GateResult[]): string {
  const parts = results
    .filter((r) => r.outcome !== "pass")
    .map((r) => {
      const { log, logs, ...rest } = (r.details ?? {}) as Record<string, unknown>;
      const files = [log, ...(Array.isArray(logs) ? logs : [])].filter((l): l is string => typeof l === "string");
      const extra = Object.keys(rest).length ? `\nDetails: ${JSON.stringify(rest)}` : "";
      const logText = files.length ? `\nLog tail:\n${tail(read(files[files.length - 1]!), LOG_TAIL_LINES)}` : "";
      return `Gate ${r.name}: ${r.outcome}${r.reason ? ` (${r.reason})` : ""}${extra}${logText}`;
    });
  return parts.join("\n\n") + "\n";
}

/** Resolve the runner evidence saved for a specific escalation history index and triggering stage. */
function escalationEvidencePath(root: string, id: string, index: number, stage: Stage | undefined): string {
  return join(runsDir(root, id), `escalation-${index}-${stage}.md`);
}

/** Show the recorded outcome that caused the escalation and any evidence saved by its runner. */
function escalationFeedback(root: string, task: TaskState, escalation: HistoryEntry): string {
  const index = task.history.indexOf(escalation);
  const trigger = task.history[index - 1];
  if (!trigger?.stage || !trigger.outcome) return "";
  const reason = trigger.reason ? ` (${trigger.reason})` : "";
  const gate = trigger.gate ? ` [${trigger.gate}]` : "";
  const summary = trigger.kind === "gates" && trigger.results ? `\n${trigger.results}` : "";
  const evidence = trigger.kind === "gates" || (trigger.kind === "complete" && trigger.results === "run")
    ? read(escalationEvidencePath(root, task.id, index, trigger.stage))
    : "";
  const evidenceHeading = trigger.stage === "verify"
    ? "Prior review round " + task.history.slice(0, index).filter(h => h.kind === "complete" && h.stage === "verify").length +
      " (the latest revision request determines scope)"
    : "Triggering gate evidence";
  return block("Triggering stage outcome", `${trigger.stage}: ${trigger.outcome}${gate}${reason}${summary}`) +
    block(evidenceHeading, evidence);
}

/** Save generation failure details and a bounded log tail for the next implementer. */
function saveGenerateFailure(
  root: string, id: string, command: string, exitCode: number | null, timedOut: boolean, log: string,
): void {
  const outcome = timedOut ? "timed out" : `exit ${exitCode}`;
  writeFileSync(join(runsDir(root, id), GENERATE_FAILURE), [
    "Generate step: fail (generate_failed)",
    `$ ${command}`,
    outcome,
    "",
    "Log tail:",
    tail(read(log), LOG_TAIL_LINES),
    "",
  ].join("\n"));
}

/** Feedback from the previous generate, gate, or verify run. */
function reworkFeedback(root: string, task: TaskState, designing = false): string {
  const reviews = task.history.filter(h => h.kind === "complete" && h.stage === "verify");
  const lastVerify = reviews.at(-1);
  const lastGates = [...task.history].reverse().find((h) => h.kind === "gates");
  const dir = runsDir(root, task.id);
  const approvedSince = lastVerify && task.history.slice(task.history.indexOf(lastVerify) + 1).some(h => h.kind === "approve");
  const raw = lastVerify?.outcome === "rework" ? read(join(dir, "verdict.md")) : "";
  const decisions = !designing && raw && reviewDecisions(read(join(changeFolder(root, task.id), "tasks.md"))).get(reviews.length);
  let heading = "Verify verdict on the previous attempt (fix every high and medium finding)";
  let verdict = raw;
  if (decisions) {
    heading = "Approved review decisions (implement fix rows only)";
    verdict = decidedFeedback(decisions, raw);
  } else if (designing) {
    heading = "Prior review round " + reviews.length + " (the latest revision request determines scope)";
  } else if (approvedSince) {
    heading = "Untriaged review from the previous plan (the approved plan defines scope)";
  }
  const gates = lastGates && lastGates.outcome !== "pass" ? read(join(dir, GATES_FAILURE)) : "";
  return (
    block(heading, verdict) +
    block("Gate failure on the previous attempt (make the gates pass)", gates) +
    block("Generate step failure on the previous attempt (make the generate command succeed)", read(join(dir, GENERATE_FAILURE)))
  );
}

/** The focused test scope of a (trusted) config, or undefined when no `test.focused` is configured. */
function focusedScope(config: Config): FocusedScope | undefined {
  return config.test.focused ? { template: config.test.focused, paths: config.test.paths } : undefined;
}

/** Resolve the configured role for a stage or raise a domain error if it is unavailable. */
function role(stage: Stage, task: TaskState, config: Config) {
  const r = roleFor(stage, task.tier, config);
  if (!r) throw new DevflowError("unknown_role", `No role configured for ${stage}.`);
  return r;
}

/** Convert role-launch failures into a failed RunResult for normal stage reporting. */
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

/** Compose the stage prompt and invoke the selected runner with explicit writes and expected outputs. */
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
  extra: { nodePrompt?: string; bash?: string[]; focused?: FocusedScope; cwd?: string; round?: number; previousVerdict?: string } = {},
): Promise<RunResult> {
  const prompt = extra.nodePrompt ?? composePrompt(loadTemplate(root, stage), {
    id: task.id,
    description: task.description,
    ...(task.tracker ? { tracker: task.tracker } : {}),
    language: config.language,
    outputs: `you may write ${write.join(", ")}` + (expect.length ? `; you must produce ${expect.join(", ")}` : ""),
    context,
    testCommand: config.test.command,
    ...(extra.focused ? { focusedCommand: extra.focused.template } : {}),
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
    ...(extra.focused ? { focused: extra.focused } : {}),
    expect,
    timeoutMs: io.timeoutMs ?? 1_800_000,
    task: task.id,
    parentEnv: io.env,
    savePrompt: true,
    ...(extra.cwd ? { cwd: extra.cwd } : {}),
  });
}

/** Generate the candidate separately. Only devflow splices it into the original OpenSpec plan. */
async function reviseNode(root: string, task: TaskState, config: Config, io: StageIo, node: string, context: string): Promise<RunResult> {
  const path = join(changeFolder(root, task.id), "tasks.md");
  const original = readFileSync(path, "utf8");
  const digest = planDigest(root, task.id);
  const copy = mkdtempSync(join(tmpdir(), "devflow-node-"));
  try {
    const prompt = [
      "You are the DESIGN role. Revise one existing OpenSpec task in light of the complete plan.",
      "Task id: " + task.id, "Task: " + task.description, "Language: " + config.language,
      "Write the replacement node to node.md. Return one unchecked Markdown task with ID " + node +
        " and its indented details. Keep requirements, other nodes and the impact zone intact.",
      context,
    ].join("\n\n");
    const result = await runModel(root, task, config, io, "design", "design", "", ["node.md"], ["node.md"], { cwd: copy, nodePrompt: prompt });
    if (!result.ok) return result;
    if (loadTask(root, task.id).updatedAt !== task.updatedAt || planDigest(root, task.id) !== digest || readFileSync(path, "utf8") !== original) {
      throw new DevflowError("plan_moved", "The plan changed while revising node " + node);
    }
    try {
      writeFileAtomic(path, replaceNode(original, node, readFileSync(join(copy, "node.md"), "utf8")));
    } catch (error) {
      if (!(error instanceof DevflowError)) throw error;
      return { ...result, ok: false, error: error.reason };
    }
    return result;
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

/** Run the task's next stage once and record its outcome. Returns undefined when nothing is runnable.
 * @param workingConfig - Project configuration before any base-pinned gate policy is applied.
 * @returns A report with the new routing decision, or undefined at a stop.
 */
export async function runNextStage(root: string, workingConfig: Config, id: string, io: StageIo): Promise<StageReport | undefined> {
  let task = loadTask(root, id);
  const config = workingConfig;
  const next = nextStage(task, config);
  if (next.stage === "review" || (!next.stage && next.reason === "awaiting_plan_approval" && task.approval === "model")) {
    return runDelegatedReview(root, config, id, io);
  }
  if (!next.stage) return undefined;
  const stage = next.stage;
  /** Pair an outcome and its optional diagnostics with the next routing decision. */
  const report = (outcome: string, t: TaskState, reason?: string, details?: unknown): StageReport => ({
    stage,
    outcome,
    ...(reason ? { reason } : {}),
    ...(details === undefined ? {} : { details }),
    next: nextStage(t, config),
  });
  /** Record a provider limit without consuming an attempt and attach transient diagnostics to the report. */
  const pauseOn = (r: RunResult, extra?: { cleanup_failed: string }): StageReport | undefined => {
    if (!r.usageLimit) return undefined;
    const { reset, runner } = r.usageLimit;
    const paused = record(root, task, { kind: "pause", stage, ...r.usageLimit }, config, io);
    return report("paused", paused, "usage_limit", { reset, runner, log: r.log, ...extra });
  };

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
      const paused = pauseOn(r);
      if (paused) return paused;
      task = record(root, task, { kind: "complete", stage, outcome: r.ok ? "ok" : "fail" }, config, io);
      return report(r.ok ? "ok" : "fail", task, r.ok ? undefined : "run_failed", r);
    }

    case "design": {
      const before = changeFileHashes(root, id);
      const folder = `openspec/changes/${id}`;
      const latest = task.history.findLast(h => h.kind === "reject" || h.kind === "tier" || h.kind === "escalate");
      const request = latest?.kind === "reject" || (latest?.kind === "escalate" && /^revision \d+$/.test(latest.results ?? ""))
        ? latest : undefined;
      const revision = request !== undefined;
      const revisionRequest = request?.kind === "escalate"
        ? `Automatic escalation ${request.from} → ${request.to} (${request.reason}): Revise the approved plan to address the triggering evidence below.`
        : request?.reason ?? "";
      const ctx =
        block("Exploration notes", read(join(runsDir(root, id), "facts.md"))) +
        block("Living specs (read as needed)", livingSpecs(root)) +
        block("Latest revision request (binding scope)", revisionRequest) +
        (revision ? block("Current plan files (revise them)", changeContext(root, id, () => true)) : "") +
        (request?.kind === "escalate" ? escalationFeedback(root, task, request) : revision ? reworkFeedback(root, task, true) : "");
      // Revisions may retain plan files. First designs must produce fresh files.
      const filesBefore = revision ? planDigest(root, id) : "";
      const required = revision ? [] : ["proposal.md", "design.md", "tasks.md"].map((f) => `${folder}/${f}`);
      const r = request?.kind === "reject" && request.node
        ? await reviseNode(root, task, config, io, request.node, ctx)
        : await runModel(root, task, config, io, "design", "design", ctx, [`${folder}/**`], required);
      const paused = pauseOn(r);
      if (paused) return paused;
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
      const trusted = gateConfig(root, task.base, config).config;
      if (task.base && !task.dirtyAtImplement && repoInfo(root)) {
        const paths = changeSet(root, task.base).filter((path) => !path.startsWith(`openspec/changes/${id}/`));
        task = record(root, task, { kind: "dirty_snapshot", paths: pathHashes(root, paths) }, config, io);
      }
      const generate = trusted.build?.generate;
      const outputs = trusted.build?.outputs ?? [];
      // Generated outputs are writable, but only through the generate command: run it whenever the tests need
      // fresh outputs. devflow runs it again after implement anyway.
      const generatedPaths = outputs.map((glob) => `- ${glob} (generated: default command \`${generate}\`; follow the approved plan within the allowed scope, never edit by hand)`);
      const impact = [...zone.map((glob) => `- ${glob}`), ...generatedPaths].join("\n");
      const ctx =
        (small ? "" : changeContext(root, id, () => true)) +
        (!small || generatedPaths.length ? block("Impact zone", impact) : "") +
        reworkFeedback(root, task);
      const generateFailure = join(runsDir(root, id), GENERATE_FAILURE);
      rmSync(generateFailure, { force: true });
      const write = [...(small ? zone : [...zone, tasksMd]), ...outputs];
      const focused = focusedScope(trusted);
      const bash = focused ? [] : [config.test.command];
      if (generate) bash.push(generate);
      const r = await runModel(root, task, config, io, small ? "small" : "implement", "implement", ctx, write, [], {
        bash,
        ...(focused ? { focused } : {}),
      });
      const paused = pauseOn(r);
      if (paused) return paused;
      const answer = r.ok && r.log ? read(r.log) : "";
      const blocked = answer ? parseBlocked(answer) : undefined;
      if (blocked) {
        task = record(root, task, { kind: "blocked", stage: "implement", reason: blocked }, config, io);
        return report("blocked", task, blocked, r);
      }
      const conflict = answer && (!small || generate) ? parsePlanConflict(answer) : undefined;
      if (conflict) {
        if (small) {
          task = record(root, task, { kind: "complete", stage, outcome: "fail" }, config, io);
          return report("fail", task, "plan_conflict", r);
        }
        const target = /^\[(\d+(?:\.\d+)+)\/[\w.-]+\]/.exec(conflict)?.[1];
        const node = target && planNodes(read(join(root, tasksMd))).has(target) ? target : undefined;
        task = record(root, task, { kind: "plan_conflict", reason: `implementer: ${conflict}`, ...(node ? { node } : {}) }, config, io);
        return report("plan_conflict", task, conflict, r);
      }
      if (r.ok && generate) {
        const generated = await runGenerate({ root, task, config: trusted, parentEnv: io.env }, root, "generate");
        if (generated && (generated.exitCode !== 0 || generated.timedOut)) {
          const { exitCode, timedOut, log } = generated;
          saveGenerateFailure(root, id, generate, exitCode, timedOut, log);
          task = record(root, task, { kind: "complete", stage, outcome: "fail" }, config, io);
          return report("fail", task, "generate_failed", { exitCode, timedOut, log });
        }
        if (generated) rmSync(generateFailure, { force: true });
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
      return runVerify(root, task, config, io, report, pauseOn);
  }
}

/** Build a disposable snapshot, collect an independent verdict and recheck evidence before accepting PASS. */
async function runVerify(
  root: string,
  task: TaskState,
  workingConfig: Config,
  io: StageIo,
  report: (outcome: string, t: TaskState, reason?: string, details?: unknown) => StageReport,
  pauseOn: (r: RunResult, extra?: { cleanup_failed: string }) => StageReport | undefined,
): Promise<StageReport> {
  const id = task.id;
  const { config } = gateConfig(root, task.base, workingConfig);
  const focused = focusedScope(config);
  const snap = snapshotDigest(root, task.base!, config);
  if (!task.gatesSnapshot || snap !== task.gatesSnapshot) {
    const t = record(root, task, { kind: "invalidate", to: "gates", reason: "snapshot_changed" }, workingConfig, io);
    return { stage: "invalidate", outcome: "snapshot_changed", next: nextStage(t, workingConfig) };
  }

  const dir = runsDir(root, id);
  const verdictPath = join(dir, "verdict.md");
  const round = task.history.filter((h) => h.kind === "complete" && h.stage === "verify").length + 1;
  let previous: string | undefined;
  let previousRound = round - 1;
  if (existsSync(verdictPath)) {
    previous = read(verdictPath);
    renameSync(verdictPath, join(dir, `verdict-round${round - 1}.md`));
  } else {
    // The last round produced no verdict (it failed): narrow against the last verdict that exists,
    // or a later round would drop the known findings it is told to re-check.
    const saved = lastSavedVerdict(dir, round - 1);
    previous = saved?.text;
    previousRound = saved?.round ?? 0;
  }

  const folder = changeFolder(root, id);
  if (previous) {
    const decisions = reviewDecisions(read(join(folder, "tasks.md"))).get(previousRound);
    if (decisions) previous = decidedFeedback(decisions, previous);
  }
  const deltas = changeContext(root, id, (f) => f.startsWith("specs/"));
  const changes = changeSet(root, task.base!);
  const ctx =
    block("Threat model and verification context", verificationContext(root, task.base!, changes)) +
    deltas +
    block(`openspec/changes/${id}/tasks.md`, read(join(folder, "tasks.md"))) +
    block("Test plan (from the design)", section(read(join(folder, "design.md")), "Test plan")) +
    block("Changed files", changes.map((p) => `- ${p}`).join("\n")) +
    block("Gate results", gatesSummary(task));

  let wt: { path: string; projectDir: string } | undefined;
  let r: RunResult | undefined;
  let failure: string | undefined;
  let leftoverCopy: string | undefined;
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
      const generated = await runGenerate({ root, task, config, parentEnv: io.env }, wt.projectDir, "verify_generate");
      if (generated && (generated.exitCode !== 0 || generated.timedOut)) failure = "verify_generate_failed";
    }
    if (!failure) {
      r = await runModel(root, task, config, io, "verify", "verify", ctx, [".devflow-verdict.md"], [".devflow-verdict.md"], {
        cwd: wt.projectDir,
        round,
        ...(previous ? { previousVerdict: previous } : {}),
        bash: focused ? [] : [config.test.command],
        ...(focused ? { focused } : {}),
      });
      if (!r.usageLimit) {
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
    }
  } catch (e) {
    failure = e instanceof DevflowError ? e.reason : "verify_error";
  } finally {
    if (wt && !(io.removeCopy ?? removeDetached)(root, wt.path)) {
      leftoverCopy = wt.path;
      failure = failure ?? "cleanup_failed";
    }
  }

  if (r?.usageLimit) return pauseOn(r, leftoverCopy ? { cleanup_failed: leftoverCopy } : undefined)!;

  const verdictText = failure ? "" : read(verdictPath);
  const verdict = verdictOf(verdictText);
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
    : { kind: "complete", stage: "verify", outcome: verdict, byRun: true };
  const t = record(root, task, event, workingConfig, io, verdict === "rework" ? verdictText : undefined);
  return report(verdict, t, undefined, { verdict: verdictPath, round });
}

/** Run stages until a human is needed, a stage fails or pauses, or the task is done.
 * @param opts - Stop after one report or notify the caller after each report.
 * @returns The ordered reports from this invocation.
 */
export async function runLoop(root: string, config: Config, id: string, io: StageIo, opts: { once?: boolean; onStage?: (r: StageReport) => void } = {}): Promise<StageReport[]> {
  const reports: StageReport[] = [];
  for (;;) {
    const r = await runNextStage(root, config, id, io);
    if (!r) break;
    reports.push(r);
    opts.onStage?.(r);
    if (opts.once) break;
    if (["fail", "blocked", "human", "stale", "paused"].includes(r.outcome)) break;
    const delegatedApproval = r.next.reason === "awaiting_plan_approval" && loadTask(root, id).approval === "model";
    if (!r.next.stage && !delegatedApproval) break;
  }
  return reports;
}
