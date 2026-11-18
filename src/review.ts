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

export interface ReviewReport {
  stage: "review";
  outcome: "approve" | "reject" | "human" | "stale";
  reason?: string;
  details?: unknown;
  next: NextInfo;
}

export function reviewRole(config: Config): Role {
  const role = config.roles.review ?? config.roles.design_complex ?? config.roles.design;
  if (role.runner !== "claude" && role.runner !== "codex") {
    throw new DevflowError("review_runner_unsupported", "The review role must run on claude or codex (it needs a read-only run).");
  }
  return role;
}

/** Last line that is a verdict, from plain output or from claude's JSON "result". */
export function parseReview(output: string): { verdict: "approve" | "reject"; reason?: string } | undefined {
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
  let found: { verdict: "approve" | "reject"; reason?: string } | undefined;
  for (const text of texts) {
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim().replace(/^\*\*|\*\*$/g, "");
      if (/^APPROVE\b/.test(t)) found = { verdict: "approve" };
      const m = /^REJECT:\s*(.+)$/.exec(t);
      if (m) found = { verdict: "reject", reason: m[1]!.trim() };
    }
  }
  return found;
}

const PROMPT = `You are the REVIEW role in a devflow task. The human delegated plan approval to you. You did not write this plan.
Judge whether the plan below is ready to implement: requirements are testable and complete for the task, the impact zone covers what must change, the test plan proves the scenarios, tasks are concrete.
You are in a folder that contains only the plan. Do not edit anything.
End your answer with exactly one final line, either:
APPROVE
or
REJECT: <the concrete changes the designer must make>
`;

/** Review a delegated plan in an isolated copy and apply the verdict if nothing changed meanwhile. */
export async function runDelegatedReview(root: string, config: Config, id: string, io: { now: () => string; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<ReviewReport> {
  const task = loadTask(root, id);
  const revision = task.planRevision ?? 1;
  const digest = planDigest(root, id, revision);
  const role = reviewRole(config);

  const dir = mkdtempSync(join(tmpdir(), "devflow-review-"));
  let output = "";
  let runOk = false;
  try {
    if (existsSync(changeFolder(root, id))) cpSync(changeFolder(root, id), join(dir, "plan"), { recursive: true });
    const plan = changeFiles(root, id)
      .map((f) => block(`plan/${f}`, readFileSync(join(changeFolder(root, id), f), "utf8")))
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
      cwd: dir,
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
  const t = transition(current, { kind: "approve", planDigest: digest, zone: check.zone!, revision, by: "model" }, config, io.now());
  saveTask(root, t);
  return { stage: "review", outcome: "approve", next: nextStage(t, config) };
}
