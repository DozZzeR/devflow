/** @file Interpret model answers and apply delegated review only to the plan snapshot actually reviewed. */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, Role } from "./config.js";
import { DEVFLOW_DIR } from "./config.js";
import { checkDesign } from "./artifacts.js";
import { DevflowError } from "./errors.js";
import { nextStage, transition, type NextInfo, type TaskState } from "./lifecycle.js";
import { block } from "./prompts.js";
import { runRole } from "./runners.js";
import { changeFiles, changeFolder, planDigest } from "./snapshot.js";
import { loadTask, saveTask } from "./store.js";

/** Delegated plan-review outcome and the next routing decision. */
export interface ReviewReport {
  /** Identifies delegated review separately from a numbered execution stage. */
  stage: "review";
  /** Whether review approves, rejects, needs intervention or has become stale. */
  outcome: "approve" | "reject" | "human" | "stale";
  /** Machine-readable explanation when the decision cannot be applied normally. */
  reason?: string;
  /** Optional diagnostic evidence associated with the review. */
  details?: unknown;
  /** Routing decision computed from the resulting or latest task state. */
  next: NextInfo;
}

/** Choose review, complex design or design in that order and require a supported read-only runner. */
export function reviewRole(config: Config): Role {
  const role = config.roles.review ?? config.roles.design_complex ?? config.roles.design;
  if (role.runner !== "claude" && role.runner !== "codex") {
    throw new DevflowError("review_runner_unsupported", "The review role must run on claude or codex (it needs a read-only run).");
  }
  return role;
}

/** The lines a role answered with: plain output plus the text of claude's JSON "result", markdown bold stripped. */
export function answerLines(output: string): string[] {
  const texts = [output];
  for (const line of output.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("{") && t.includes('"result"')) {
      try {
        const j = JSON.parse(t) as { result?: unknown };
        if (typeof j.result === "string") texts.push(j.result);
      } catch {
        /* not JSON */
      }
    }
  }
  return texts.flatMap((text) => text.split(/\r?\n/).map((l) => l.trim().replace(/^\*\*|\*\*$/g, "")));
}

/** The implementer's "PLAN CONFLICT: ..." line, if its answer has one (the last one wins). */
export function parsePlanConflict(output: string): string | undefined {
  let found: string | undefined;
  for (const t of answerLines(output)) {
    const m = /^PLAN CONFLICT:\s*(.+)$/.exec(t);
    if (m) found = m[1]!.trim();
  }
  return found;
}

/** The implementer's "BLOCKED: ..." line, if its answer has one (the last one wins). */
export function parseBlocked(output: string): string | undefined {
  let found: string | undefined;
  for (const t of answerLines(output)) {
    const m = /^BLOCKED:\s*(.+)$/.exec(t);
    if (m) found = m[1]!.trim();
  }
  return found;
}

/** Last line that is a verdict, from plain output or from claude's JSON "result". */
export function parseReview(output: string): { verdict: "approve" | "reject"; reason?: string } | undefined {
  let found: { verdict: "approve" | "reject"; reason?: string } | undefined;
  for (const t of answerLines(output)) {
    if (/^APPROVE\b/.test(t)) found = { verdict: "approve" };
    const m = /^REJECT:\s*(.+)$/.exec(t);
    if (m) found = { verdict: "reject", reason: m[1]!.trim() };
  }
  return found;
}

/** Instructions for judging the feasibility, testability and scope of the submitted plan. */
const PROMPT = `You are the REVIEW role in a devflow task. The human delegated plan approval to you. You did not write this plan.
Judge whether the plan below is ready to implement: requirements are testable and complete for the task, the impact zone covers what must change, the test plan proves the scenarios, tasks are concrete.
You are in a folder that contains only the plan. Do not edit anything.
Your final line must be the single word APPROVE, or the word REJECT followed by a colon and the concrete changes the designer must make (for example "REJECT" + ": add a test for negative input"). Nothing after that line.
`;

/** Review a delegated plan in an isolated copy and apply the verdict if nothing changed meanwhile. */
export async function runDelegatedReview(root: string, config: Config, id: string, io: { now: () => string; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<ReviewReport> {
  const task = loadTask(root, id);
  const revision = task.planRevision ?? 1;
  const role = reviewRole(config);

  // Snapshot the plan first; the digest, the prompt and the review all refer to this copy.
  const dir = mkdtempSync(join(tmpdir(), "devflow-review-"));
  const copyRoot = join(dir, "snapshot");
  if (existsSync(changeFolder(root, id))) cpSync(changeFolder(root, id), changeFolder(copyRoot, id), { recursive: true });
  const digest = planDigest(copyRoot, id, revision);
  let output = "";
  let runOk = false;
  try {
    const plan = changeFiles(copyRoot, id)
      .map((f) => block(`plan/${f}`, readFileSync(join(changeFolder(copyRoot, id), f), "utf8")))
      .join("");
    const prompt = `${PROMPT}\nTask id: ${id}\nTask: ${task.description}\nPlan revision: ${revision}\n\n${plan}`;
    const r = await runRole({
      root,
      roleName: "review",
      role,
      config,
      prompt,
      write: [],
      bash: [],
      expect: [],
      timeoutMs: io.timeoutMs ?? 1_800_000,
      task: id,
      parentEnv: io.env,
      savePrompt: true,
      cwd: changeFolder(copyRoot, id),
    });
    runOk = r.ok;
    output = existsSync(r.log) ? readFileSync(r.log, "utf8") : "";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const parsed = runOk ? parseReview(output) : undefined;
  writeFileSync(join(root, DEVFLOW_DIR, "runs", id, "review.md"), parsed ? (parsed.verdict === "approve" ? "APPROVE\n" : `REJECT: ${parsed.reason}\n`) : "UNREADABLE\n");

  const current = loadTask(root, id);
  const unchanged =
    current.status === "DESIGNED" &&
    current.approval === "model" &&
    (current.planRevision ?? 1) === revision &&
    planDigest(root, id, revision) === digest;
  if (!unchanged) {
    return { stage: "review", outcome: "stale", reason: "review_stale", next: nextStage(current, config) };
  }
  if (!parsed) {
    const t = transition(current, { kind: "delegate", to: "human" }, config, io.now());
    t.history.push({ at: io.now(), kind: "review", reason: runOk ? "unreadable_review" : "review_run_failed" });
    saveTask(root, t);
    return { stage: "review", outcome: "human", reason: runOk ? "unreadable_review" : "review_run_failed", next: nextStage(t, config) };
  }
  if (parsed.verdict === "reject") {
    let t = transition(current, { kind: "reject", reason: parsed.reason ?? "rejected by reviewer", revision, by: "model" }, config, io.now());
    // A reviewer and a designer must not loop forever: after three model rejections the human decides.
    if (t.history.filter((h) => h.kind === "reject" && h.results === "by model").length >= 3) {
      t = transition(t, { kind: "delegate", to: "human" }, config, io.now());
      t.history.push({ at: io.now(), kind: "review", reason: "review_rejections_limit" });
    }
    saveTask(root, t);
    return { stage: "review", outcome: "reject", reason: parsed.reason, next: nextStage(t, config) };
  }
  const check = await checkDesign(root, id, config);
  if (!check.ok) {
    const t = transition(current, { kind: "reject", reason: `design checks: ${check.reason}`, revision, by: "model" }, config, io.now());
    saveTask(root, t);
    return { stage: "review", outcome: "reject", reason: check.reason, next: nextStage(t, config) };
  }
  // The design checks are asynchronous: re-check that nothing moved before recording the approval.
  const latest = loadTask(root, id);
  if (
    latest.updatedAt !== current.updatedAt ||
    latest.approval !== "model" ||
    planDigest(root, id, revision) !== digest
  ) {
    return { stage: "review", outcome: "stale", reason: "review_stale", next: nextStage(latest, config) };
  }
  const t = transition(latest, { kind: "approve", planDigest: digest, zone: check.zone!, revision, by: "model" }, config, io.now());
  saveTask(root, t);
  return { stage: "review", outcome: "approve", next: nextStage(t, config) };
}
