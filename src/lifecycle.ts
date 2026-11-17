import { z } from "zod";
import type { Config, Role } from "./config.js";
import { DevflowError } from "./errors.js";

export const TIERS = ["small", "medium", "complex"] as const;
export type Tier = (typeof TIERS)[number];

export const STATES = [
  "NEW",
  "EXPLORED",
  "DESIGNED",
  "PLAN_APPROVED",
  "IMPLEMENTED",
  "GATES_PASSED",
  "DONE",
  "HUMAN",
] as const;
export type TaskStatus = (typeof STATES)[number];

export const STAGES = ["explore", "design", "implement", "gates", "verify"] as const;
export type Stage = (typeof STAGES)[number];

export const OUTCOMES: Record<Stage, readonly string[]> = {
  explore: ["ok", "fail"],
  design: ["ok", "fail"],
  implement: ["ok", "fail"],
  gates: ["ok", "fail"],
  verify: ["pass", "rework", "human"],
};

const HistoryEntrySchema = z.object({
  at: z.string(),
  kind: z.enum(["start", "complete", "approve", "resume", "tier", "escalate"]),
  stage: z.enum(STAGES).optional(),
  outcome: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  reason: z.string().optional(),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

export const TaskStateSchema = z.strictObject({
  schema: z.literal(1),
  id: z.string(),
  description: z.string(),
  tier: z.enum(TIERS),
  tracker: z.string().optional(),
  status: z.enum(STATES),
  humanReason: z.string().optional(),
  attempts: z.strictObject({
    explore: z.number().int().nonnegative(),
    design: z.number().int().nonnegative(),
    implement: z.number().int().nonnegative(),
    verify: z.number().int().nonnegative(),
  }),
  lastVerdict: z.strictObject({ outcome: z.string(), at: z.string() }).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  history: z.array(HistoryEntrySchema),
});
export type TaskState = z.infer<typeof TaskStateSchema>;

export type Event =
  | { kind: "complete"; stage: Stage; outcome: string }
  | { kind: "approve" }
  | { kind: "resume" }
  | { kind: "tier"; tier: Tier }
  | { kind: "escalate"; reason: string };

export interface NextInfo {
  id: string;
  status: TaskStatus;
  tier: Tier;
  stage: Stage | null;
  reason?: string;
  role?: Role;
  attempt?: number;
}

const ZERO_ATTEMPTS = { explore: 0, design: 0, implement: 0, verify: 0 };

export function newTask(id: string, description: string, tier: Tier, tracker: string | undefined, now: string): TaskState {
  const task: TaskState = {
    schema: 1,
    id,
    description,
    tier,
    status: "NEW",
    attempts: { ...ZERO_ATTEMPTS },
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, kind: "start", to: tier }],
  };
  if (tracker) task.tracker = tracker;
  return task;
}

/** Status in which the task is ready to run `implement`. */
function readyToImplement(tier: Tier): TaskStatus {
  return tier === "small" ? "NEW" : "PLAN_APPROVED";
}

function stageFor(task: TaskState): { stage: Stage | null; reason?: string } {
  if (task.status === "DONE") return { stage: null, reason: "done" };
  if (task.status === "HUMAN") return { stage: null, reason: task.humanReason ?? "human" };
  if (task.tier === "small") {
    switch (task.status) {
      case "NEW":
        return { stage: "implement" };
      case "IMPLEMENTED":
        return { stage: "gates" };
      default:
        return { stage: null, reason: "inconsistent_state" };
    }
  }
  switch (task.status) {
    case "NEW":
      return { stage: "explore" };
    case "EXPLORED":
      return { stage: "design" };
    case "DESIGNED":
      return { stage: null, reason: "awaiting_plan_approval" };
    case "PLAN_APPROVED":
      return { stage: "implement" };
    case "IMPLEMENTED":
      return { stage: "gates" };
    case "GATES_PASSED":
      return { stage: "verify" };
  }
}

export function roleFor(stage: Stage, tier: Tier, config: Config): Role | undefined {
  switch (stage) {
    case "explore":
      return config.roles.explore;
    case "design":
      return tier === "complex" ? (config.roles.design_complex ?? config.roles.design) : config.roles.design;
    case "implement":
      return tier === "small" ? config.roles.small : config.roles.implement;
    case "verify":
      return config.roles.verify;
    case "gates":
      return undefined;
  }
}

export function nextStage(task: TaskState, config: Config): NextInfo {
  const { stage, reason } = stageFor(task);
  const info: NextInfo = { id: task.id, status: task.status, tier: task.tier, stage };
  if (reason) info.reason = reason;
  if (stage) {
    const role = roleFor(stage, task.tier, config);
    if (role) info.role = role;
    if (stage !== "gates") info.attempt = task.attempts[stage] + 1;
  }
  return info;
}

const TIER_ORDER: Record<Tier, number> = { small: 0, medium: 1, complex: 2 };

/** Pure transition. Returns a new state or throws DevflowError; never mutates `task`. */
export function transition(task: TaskState, event: Event, config: Config, now: string): TaskState {
  const t: TaskState = structuredClone(task);
  t.updatedAt = now;

  const toHuman = (reason: string) => {
    t.status = "HUMAN";
    t.humanReason = reason;
  };
  /** Route back to implement, or to HUMAN if implement attempts are exhausted. */
  const backToImplement = () => {
    if (t.attempts.implement >= config.limits.implement) toHuman("limit_reached");
    else t.status = readyToImplement(t.tier);
  };

  switch (event.kind) {
    case "complete": {
      const { stage, outcome } = event;
      const expected = stageFor(task).stage;
      if (stage !== expected) {
        throw new DevflowError(
          "stage_not_next",
          `Stage "${stage}" is not next for task ${task.id} (next: ${expected ?? "none"}).`,
        );
      }
      if (!OUTCOMES[stage].includes(outcome)) {
        throw new DevflowError(
          "invalid_outcome",
          `Outcome "${outcome}" is not valid for stage "${stage}" (allowed: ${OUTCOMES[stage].join(", ")}).`,
        );
      }
      t.history.push({ at: now, kind: "complete", stage, outcome });
      switch (stage) {
        case "explore":
          t.attempts.explore++;
          if (outcome === "ok") t.status = "EXPLORED";
          break;
        case "design":
          t.attempts.design++;
          if (outcome === "ok") t.status = "DESIGNED";
          break;
        case "implement":
          t.attempts.implement++;
          if (outcome === "ok") t.status = "IMPLEMENTED";
          else backToImplement();
          break;
        case "gates":
          if (outcome === "ok") t.status = t.tier === "small" ? "DONE" : "GATES_PASSED";
          else backToImplement();
          break;
        case "verify":
          t.attempts.verify++;
          t.lastVerdict = { outcome, at: now };
          if (outcome === "pass") t.status = "DONE";
          else if (outcome === "human") toHuman("verify_requested_human");
          else if (t.attempts.verify >= config.limits.verify) toHuman("limit_reached");
          else backToImplement();
          break;
      }
      if (t.status !== "HUMAN") delete t.humanReason;
      return t;
    }

    case "approve": {
      if (task.status !== "DESIGNED") {
        throw new DevflowError("not_awaiting_approval", `Task ${task.id} is not awaiting plan approval (status: ${task.status}).`);
      }
      t.status = "PLAN_APPROVED";
      t.history.push({ at: now, kind: "approve" });
      return t;
    }

    case "resume": {
      if (task.status !== "HUMAN") {
        throw new DevflowError("not_waiting_for_human", `Task ${task.id} is not waiting for a human (status: ${task.status}).`);
      }
      t.attempts.implement = 0;
      t.attempts.verify = 0;
      t.status = readyToImplement(t.tier);
      delete t.humanReason;
      t.history.push({ at: now, kind: "resume" });
      return t;
    }

    case "tier": {
      if (task.status === "DONE") throw new DevflowError("task_done", `Task ${task.id} is done.`);
      const from = task.tier;
      const to = event.tier;
      if (from === to) throw new DevflowError("same_tier", `Task ${task.id} is already ${to}.`);
      applyTierChange(t, to);
      t.history.push({ at: now, kind: "tier", from, to });
      return t;
    }

    case "escalate": {
      if (task.status === "DONE") throw new DevflowError("task_done", `Task ${task.id} is done.`);
      if (task.tier === "complex") {
        throw new DevflowError("cannot_escalate", `Task ${task.id} is already complex; escalation goes to a human.`);
      }
      const from = task.tier;
      const to: Tier = from === "small" ? "medium" : "complex";
      applyTierChange(t, to);
      t.history.push({ at: now, kind: "escalate", from, to, reason: event.reason });
      return t;
    }
  }
}

/**
 * Re-plan after a tier change. Going to small or coming from small restarts the task;
 * medium → complex re-runs design with the stronger role; complex → medium keeps progress.
 */
function applyTierChange(t: TaskState, to: Tier): void {
  const from = t.tier;
  t.tier = to;
  delete t.humanReason;
  if (from === "small" || to === "small") {
    t.status = "NEW";
    t.attempts = { ...ZERO_ATTEMPTS };
    return;
  }
  t.attempts.implement = 0;
  t.attempts.verify = 0;
  if (TIER_ORDER[to] > TIER_ORDER[from]) {
    t.status = "EXPLORED";
  } else if (t.status === "HUMAN") {
    t.status = "PLAN_APPROVED";
  }
}
