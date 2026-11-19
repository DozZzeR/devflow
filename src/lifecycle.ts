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
  kind: z.enum(["start", "complete", "approve", "resume", "tier", "escalate", "gates", "override", "base", "zone", "invalidate", "reject", "delegate", "review", "blocked"]),
  stage: z.enum(STAGES).optional(),
  gate: z.string().optional(),
  results: z.string().optional(),
  outcome: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  reason: z.string().optional(),
  node: z.string().optional(),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

/** Implement may send a plan back to design this many times before a human decides. */
export const PLAN_CONFLICT_LIMIT = 2;

export const COUNTERS_ZERO = { gatesFailedInARow: 0, reworks: 0, staleEvidence: 0 };

export const TaskStateSchema = z.strictObject({
  schema: z.literal(2),
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
  lastVerdict: z.strictObject({ outcome: z.string(), at: z.string(), snapshot: z.string().optional() }).optional(),
  planDigest: z.string().optional(),
  planRevision: z.number().int().positive().optional(),
  approval: z.enum(["human", "model"]).optional(),
  gatesSnapshot: z.string().optional(),
  base: z.string().optional(),
  zone: z.array(z.string()).optional(),
  counters: z.strictObject({
    gatesFailedInARow: z.number().int().nonnegative(),
    reworks: z.number().int().nonnegative(),
    staleEvidence: z.number().int().nonnegative().default(0),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
  history: z.array(HistoryEntrySchema),
});
export type TaskState = z.infer<typeof TaskStateSchema>;

export type GateOutcome = "pass" | "fail" | "blocked";

export type Event =
  | { kind: "complete"; stage: Stage; outcome: string; override?: string; evidence?: string; byRun?: boolean }
  | { kind: "gates"; outcome: GateOutcome; gate?: string; reason?: string; results?: string; snapshot?: string }
  | { kind: "approve"; planDigest?: string; zone?: string[]; revision?: number; by?: "model" }
  | { kind: "invalidate"; to: "approval" | "gates"; reason: string }
  | { kind: "reject"; reason: string; node?: string; revision?: number; by?: "model" }
  | { kind: "plan_conflict"; reason: string; node?: string }
  | { kind: "blocked"; stage: Stage; reason: string }
  | { kind: "delegate"; to: "human" | "model" }
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
    schema: 2,
    id,
    description,
    tier,
    status: "NEW",
    attempts: { ...ZERO_ATTEMPTS },
    counters: { ...COUNTERS_ZERO },
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
  /** Automatic escalation by one tier; complex goes to a human instead. The working tree is never touched. */
  const autoEscalate = (reason: string) => {
    if (t.tier === "complex") {
      toHuman(reason);
      return;
    }
    const from = t.tier;
    const to: Tier = from === "small" ? "medium" : "complex";
    applyTierChange(t, to);
    t.attempts = { ...ZERO_ATTEMPTS };
    t.history.push({ at: now, kind: "escalate", from, to, reason });
  };
  /** Apply a gates result once the stage order has been checked. */
  const applyGates = (outcome: GateOutcome, gate: string | undefined, reason: string | undefined, snapshot?: string) => {
    if (outcome !== "pass") delete t.gatesSnapshot;
    if (outcome === "pass") {
      t.counters.gatesFailedInARow = 0;
      if (snapshot) t.gatesSnapshot = snapshot;
      else delete t.gatesSnapshot;
      t.status = t.tier === "small" ? "DONE" : "GATES_PASSED";
    } else if (outcome === "blocked") {
      toHuman(reason ?? "gates_blocked");
    } else {
      t.counters.gatesFailedInARow++;
      if (gate === "zone") autoEscalate("zone_violation");
      else if (t.counters.gatesFailedInARow >= config.limits.escalate_after) autoEscalate("gates_failed_repeatedly");
      else backToImplement();
    }
  };
  const checkNext = (stage: Stage) => {
    const expected = stageFor(task).stage;
    if (stage !== expected) {
      throw new DevflowError("stage_not_next", `Stage "${stage}" is not next for task ${task.id} (next: ${expected ?? "none"}).`);
    }
  };

  switch (event.kind) {
    case "complete": {
      const { stage, outcome } = event;
      checkNext(stage);
      if (!OUTCOMES[stage].includes(outcome)) {
        throw new DevflowError(
          "invalid_outcome",
          `Outcome "${outcome}" is not valid for stage "${stage}" (allowed: ${OUTCOMES[stage].join(", ")}).`,
        );
      }
      if (stage === "gates" && outcome === "ok" && !event.override) {
        throw new DevflowError(
          "gates_need_gate_run",
          `Record gates with "devflow gate ${task.id}", or use --override "<reason>" to accept them by hand.`,
        );
      }
      if (stage === "verify" && outcome === "pass" && !event.override) {
        if (!event.evidence || event.evidence !== task.gatesSnapshot) {
          throw new DevflowError(
            "verify_needs_run",
            `Record verify with "devflow run ${task.id}", or use --override "<reason>" to accept it by hand.`,
          );
        }
      }
      if (stage === "verify" && event.override) {
        t.history.push({ at: now, kind: "override", stage, outcome, reason: event.override });
      } else if (stage === "gates" && event.override) {
        t.history.push({ at: now, kind: "override", stage, outcome, reason: event.override });
      } else {
        t.history.push({ at: now, kind: "complete", stage, outcome, ...(event.byRun ? { results: "run" } : {}) });
      }
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
          applyGates(outcome === "ok" ? "pass" : "fail", undefined, undefined);
          break;
        case "verify":
          t.attempts.verify++;
          t.lastVerdict = event.evidence ? { outcome, at: now, snapshot: event.evidence } : { outcome, at: now };
          if (outcome === "pass") t.status = "DONE";
          else if (outcome === "human") toHuman("verify_requested_human");
          else {
            t.counters.reworks++;
            if (t.tier === "medium" && t.counters.reworks >= 2) autoEscalate("rework_repeated");
            else if (t.attempts.verify >= config.limits.verify) toHuman("limit_reached");
            else backToImplement();
          }
          break;
      }
      if (t.status !== "HUMAN") delete t.humanReason;
      return t;
    }

    case "gates": {
      checkNext("gates");
      t.history.push({
        at: now,
        kind: "gates",
        stage: "gates",
        outcome: event.outcome,
        ...(event.gate ? { gate: event.gate } : {}),
        ...(event.reason ? { reason: event.reason } : {}),
        ...(event.results ? { results: event.results } : {}),
      });
      applyGates(event.outcome, event.gate, event.reason, event.snapshot);
      if (t.status !== "HUMAN") delete t.humanReason;
      return t;
    }

    case "invalidate": {
      const allowed: TaskStatus[] = ["PLAN_APPROVED", "IMPLEMENTED", "GATES_PASSED"];
      if (!allowed.includes(task.status)) {
        throw new DevflowError("cannot_invalidate", `Task ${task.id} has no evidence to invalidate (status: ${task.status}).`);
      }
      t.counters.staleEvidence++;
      t.history.push({ at: now, kind: "invalidate", to: event.to, reason: event.reason });
      delete t.gatesSnapshot;
      if (t.counters.staleEvidence >= 3) {
        toHuman("evidence_unstable");
        return t;
      }
      if (event.to === "approval") {
        t.status = t.tier === "small" ? "NEW" : "DESIGNED";
        delete t.planDigest;
      } else {
        t.status = "IMPLEMENTED";
      }
      delete t.humanReason;
      return t;
    }

    case "delegate": {
      t.approval = event.to;
      t.history.push({ at: now, kind: "delegate", to: event.to });
      return t;
    }

    case "reject": {
      const reopen = task.status === "HUMAN" && task.humanReason === "plan_conflicts_limit" && !event.by && event.revision !== undefined;
      if (task.status !== "DESIGNED" && !reopen) {
        throw new DevflowError("not_awaiting_approval", `Task ${task.id} is not awaiting plan approval (status: ${task.status}).`);
      }
      if (event.revision !== undefined && event.revision !== (task.planRevision ?? 1)) {
        throw new DevflowError("plan_moved", `Revision ${event.revision} is not the current plan (revision ${task.planRevision ?? 1}).`);
      }
      t.status = "EXPLORED";
      delete t.humanReason;
      delete t.gatesSnapshot;
      delete t.planDigest;
      t.planRevision = (t.planRevision ?? 1) + 1;
      // A new plan starts with fresh implement and verify attempts.
      t.attempts.implement = 0;
      t.attempts.verify = 0;
      t.history.push({ at: now, kind: "reject", reason: event.reason, ...(event.node ? { node: event.node } : {}), to: `revision ${t.planRevision}`, ...(event.by ? { results: "by model" } : {}) });
      return t;
    }

    case "blocked": {
      // The role could not work for a reason outside the task (access, tools): a human fixes the environment
      // and resumes. No attempt is spent.
      toHuman("role_blocked");
      t.history.push({ at: now, kind: "blocked", stage: event.stage, reason: event.reason });
      return t;
    }

    case "plan_conflict": {
      // The implementer found the approved plan itself wrong: it goes back to design as a new revision,
      // and the new revision needs approval again. Twice in a row means the plan does not converge.
      if (task.status !== "PLAN_APPROVED" || task.tier === "small") {
        throw new DevflowError("no_approved_plan", `Task ${task.id} has no approved plan to send back (status: ${task.status}).`);
      }
      const key = (reason: string) => {
        const text = reason.replace(/^implementer:\s*/i, "").trim().toLowerCase();
        return /^\[([\w./-]+)\]/.exec(text)?.[1] ?? text.replace(/\s+/g, " ");
      };
      const reset = task.history.findLastIndex(h => (h.kind === "reject" && !h.results) ||
        (h.kind === "complete" && h.stage === "implement" && h.outcome === "ok"));
      const conflicts = task.history.slice(reset + 1).filter(h => h.kind === "reject" &&
        h.results === "by implement" && key(h.reason ?? "") === key(event.reason)).length;
      t.history.push({ at: now, kind: "reject", reason: event.reason, ...(event.node ? { node: event.node } : {}), to: `revision ${(t.planRevision ?? 1) + 1}`, results: "by implement" });
      if (conflicts >= PLAN_CONFLICT_LIMIT - 1) {
        toHuman("plan_conflicts_limit");
        return t;
      }
      t.status = "EXPLORED";
      delete t.planDigest;
      delete t.gatesSnapshot;
      t.planRevision = (t.planRevision ?? 1) + 1;
      t.attempts.implement = 0;
      t.attempts.verify = 0;
      return t;
    }

    case "approve": {
      if (task.status !== "DESIGNED") {
        throw new DevflowError("not_awaiting_approval", `Task ${task.id} is not awaiting plan approval (status: ${task.status}).`);
      }
      if (event.revision !== undefined && event.revision !== (task.planRevision ?? 1)) {
        throw new DevflowError("plan_moved", `Revision ${event.revision} is not the current plan (revision ${task.planRevision ?? 1}).`);
      }
      t.status = "PLAN_APPROVED";
      if (event.planDigest) t.planDigest = event.planDigest;
      if (event.zone) t.zone = event.zone;
      t.history.push({ at: now, kind: "approve", ...(event.by ? { results: "by model" } : {}) });
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
  t.counters = { ...COUNTERS_ZERO };
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
