/** @file Define task states and compute valid transitions from recorded events without filesystem I/O. */

import { z } from "zod";
import type { Config, Role } from "./config.js";
import { DevflowError } from "./errors.js";

/** Supported task complexities in increasing order. */
export const TIERS = ["small", "medium", "complex"] as const;
/** Complexity used to select stage routing and role variants. */
export type Tier = (typeof TIERS)[number];

/** Values accepted for the persisted workflow status. */
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
/** Last committed position in the task lifecycle. */
export type TaskStatus = (typeof STATES)[number];

/** Stages with attempt counters or gate outcomes. */
export const STAGES = ["explore", "design", "implement", "gates", "verify"] as const;
/** Stage accepted by manual completion and stage selection. */
export type Stage = (typeof STAGES)[number];

/** Allowed manual completion outcomes, indexed by stage. */
export const OUTCOMES: Record<Stage, readonly string[]> = {
  explore: ["ok", "fail"],
  design: ["ok", "fail"],
  implement: ["ok", "fail"],
  gates: ["ok", "fail"],
  verify: ["pass", "rework", "human"],
};

/** Validate one history record while allowing stage-specific optional evidence. */
const HistoryEntrySchema = z.object({
  /** Timestamp of the recorded decision. */
  at: z.string(),
  /** Event category used to interpret the optional history fields. */
  kind: z.enum(["start", "complete", "approve", "resume", "tier", "escalate", "gates", "override", "base", "zone", "invalidate", "reject", "delegate", "review", "blocked", "pause", "dirty"]),
  /** Stage associated with the recorded event, when applicable. */
  stage: z.enum(STAGES).optional(),
  /** First gate that stopped a gate run. */
  gate: z.string().optional(),
  /** Serialized gate evidence or attribution of a model or implementer decision. */
  results: z.string().optional(),
  /** Reported completion or gate outcome. */
  outcome: z.string().optional(),
  /** Prior tier or value for a recorded change. */
  from: z.string().optional(),
  /** Target tier, revision or routing destination. */
  to: z.string().optional(),
  /** Operator feedback or machine-readable explanation. */
  reason: z.string().optional(),
  /** Stable OpenSpec task ID for a scoped plan revision. */
  node: z.string().optional(),
});
/** Audit record of a transition, decision or change of task metadata. */
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

/** The conflict with the same issue key at this count sends the decision to a human. */
export const PLAN_CONFLICT_LIMIT = 2;

/** Initial counts for consecutive gate failures, reworks and stale evidence. */
export const COUNTERS_ZERO = { gatesFailedInARow: 0, reworks: 0, staleEvidence: 0 };

// z.record discards "__proto__", which is a valid Git path.
/** Preserve Git path keys, including __proto__, and validate each saved hash or deletion. */
const DirtyPathsSchema = z.custom<Record<string, string | null>>((value) => {
  if (value === null || typeof value !== "object") return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Object.values(value).every((hash) => hash === null || typeof hash === "string");
});

/** Validate the schema-2 record read from state.json before routing a task. */
export const TaskStateSchema = z.strictObject({
  /** Persistent format version accepted by this reader. */
  schema: z.literal(2),
  /** Task ID shared by the run directory and OpenSpec change. */
  id: z.string(),
  /** Original task statement supplied to the roles. */
  description: z.string(),
  /** Complexity selecting the small or planned workflow. */
  tier: z.enum(TIERS),
  /** Optional external issue reference. */
  tracker: z.string().optional(),
  /** Last committed checkpoint used to select the next stage. */
  status: z.enum(STATES),
  /** Reason to inspect before resuming a task in HUMAN. */
  humanReason: z.string().optional(),
  /** Recorded attempts per model-driven stage, reset by specific transitions. */
  attempts: z.strictObject({
    explore: z.number().int().nonnegative(),
    design: z.number().int().nonnegative(),
    implement: z.number().int().nonnegative(),
    verify: z.number().int().nonnegative(),
  }),
  /** Most recent verification outcome and the snapshot it accepted, when available. */
  lastVerdict: z.strictObject({ outcome: z.string(), at: z.string(), snapshot: z.string().optional() }).optional(),
  /** Hash binding plan approval to the reviewed revision and artifacts. */
  planDigest: z.string().optional(),
  /** Revision used to reject stale approval and scope plan feedback. */
  planRevision: z.number().int().positive().optional(),
  /** Owner of plan approval, defaulting to the human when absent. */
  approval: z.enum(["human", "model"]).optional(),
  /** Content digest accepted by the last successful full gate run. */
  gatesSnapshot: z.string().optional(),
  /** Git commit used for change detection and rollback verification. */
  base: z.string().optional(),
  /** Approved project-relative write globs. */
  zone: z.array(z.string()).optional(),
  /** Provider-limit interruption that preserves the current status and attempt. */
  pause: z.strictObject({
    stage: z.enum([...STAGES, "review"]),
    reason: z.literal("usage_limit"),
    runner: z.string(),
    at: z.string(),
    reset: z.string().optional(),
  }).optional(),
  /** Initial content hashes of paths already changed when implementation first began. */
  dirtyAtImplement: z.strictObject({
    at: z.string(),
    paths: DirtyPathsSchema,
  }).optional(),
  /** Escalation and invalidation counts tracked separately from role attempts. */
  counters: z.strictObject({
    gatesFailedInARow: z.number().int().nonnegative(),
    reworks: z.number().int().nonnegative(),
    staleEvidence: z.number().int().nonnegative().default(0),
  }),
  /** Timestamp recorded when the task was started. */
  createdAt: z.string(),
  /** Timestamp checked before recording a long-running stage result. */
  updatedAt: z.string(),
  /** Ordered events used to explain routing, reviews and retries. */
  history: z.array(HistoryEntrySchema),
});
/** Persistent lifecycle data used to choose and validate the next transition. */
export type TaskState = z.infer<typeof TaskStateSchema>;

/** Distinguish a correct change, a failed check and unavailable evidence. */
export type GateOutcome = "pass" | "fail" | "blocked";

/** Discriminated input to the reducer, including human decisions and recorded execution results. */
export type Event =
  | { kind: "pause"; stage: Stage | "review"; runner: string; reset?: string }
  | { kind: "dirty_snapshot"; paths: Record<string, string | null> }
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

/** Public routing decision returned by next and embedded in stage reports. */
export interface NextInfo {
  /** Identifier of the task being routed. */
  id: string;
  /** Persisted state from which this decision was derived. */
  status: TaskStatus;
  /** Complexity selecting the applicable route. */
  tier: Tier;
  /** Next runnable stage, including a paused delegated review, or null at a stop. */
  stage: Stage | "review" | null;
  /** Machine-readable explanation when routing stops or requires approval. */
  reason?: string;
  /** Configured model assignment for a model-driven stage. */
  role?: Role;
  /** One-based number the next role invocation would consume on completion. */
  attempt?: number;
  /** Recorded subscription limit and the affected stage, when present. */
  pause?: TaskState["pause"];
}

/** Fresh attempt counts used at task creation and on qualifying resets. */
const ZERO_ATTEMPTS = { explore: 0, design: 0, implement: 0, verify: 0 };

/** Create an in-memory NEW task with empty counters and a start history entry. */
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

/**
 * Map status and tier to a runnable stage or an explicit stop reason.
 * A medium task escalated to complex returns to EXPLORED for design and needs approval at DESIGNED.
 */
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

/** Select a role for a stage, including small implementation and complex design overrides. */
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

/** Choose review, complex design or design in that order and require a supported read-only runner. */
export function reviewRole(config: Config): Role {
  const role = config.roles.review ?? config.roles.design_complex ?? config.roles.design;
  if (role.runner !== "claude" && role.runner !== "codex") {
    throw new DevflowError("review_runner_unsupported", "The review role must run on claude or codex (it needs a read-only run).");
  }
  return role;
}

/**
 * Combine the routing decision with role and attempt information for CLI and orchestration.
 * @returns The next stage and role, or a stop reason when no stage is runnable.
 */
export function nextStage(task: TaskState, config: Config): NextInfo {
  const { stage, reason } = stageFor(task);
  const info: NextInfo = { id: task.id, status: task.status, tier: task.tier, stage };
  if (task.pause) info.pause = task.pause;
  if (reason) info.reason = reason;
  if (task.status === "DESIGNED" && task.approval === "model" && task.pause?.stage === "review") {
    info.stage = "review";
    info.role = reviewRole(config);
  } else if (stage) {
    const role = roleFor(stage, task.tier, config);
    if (role) info.role = role;
    if (stage !== "gates") info.attempt = task.attempts[stage] + 1;
  }
  return info;
}

/** Compare planning depth when switching between medium and complex. */
const TIER_ORDER: Record<Tier, number> = { small: 0, medium: 1, complex: 2 };

/** Pure transition. Returns a new state or throws DevflowError; never mutates `task`.
 * @param task - Previously persisted state.
 * @param now - Timestamp shared by the new state and its history entry.
 * @returns A fresh task state suitable for persistence.
 * @throws DevflowError if the event is invalid for this task.
 */
export function transition(task: TaskState, event: Event, config: Config, now: string): TaskState {
  const t: TaskState = structuredClone(task);
  t.updatedAt = now;
  if (event.kind !== "pause") delete t.pause;

  /** Stop routing and record the reason exposed to the operator. */
  const toHuman = (reason: string) => {
    t.status = "HUMAN";
    t.humanReason = reason;
  };
  /** Route back to implement, or to HUMAN if implement attempts are exhausted. */
  const backToImplement = () => {
    if (t.attempts.implement >= config.limits.implement) toHuman("limit_reached");
    else t.status = readyToImplement(t.tier);
  };
  /**
   * Route a gate or rework escalation to the next tier, or to a human at complex.
   * Medium to complex starts one plan revision here, so design retries reuse it.
   */
  const autoEscalate = (reason: string) => {
    if (t.tier === "complex") {
      toHuman(reason);
      return;
    }
    const from = t.tier;
    const to: Tier = from === "small" ? "medium" : "complex";
    applyTierChange(t, to);
    t.attempts = { ...ZERO_ATTEMPTS };
    let results: string | undefined;
    if (from === "medium" && to === "complex") {
      t.planRevision = (t.planRevision ?? 1) + 1;
      delete t.planDigest;
      delete t.gatesSnapshot;
      results = `revision ${t.planRevision}`;
    }
    t.history.push({ at: now, kind: "escalate", from, to, reason, ...(results ? { results } : {}) });
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
  /** Reject an outcome for a stage other than the one currently allowed. */
  const checkNext = (stage: Stage) => {
    const expected = stageFor(task).stage;
    if (stage !== expected) {
      throw new DevflowError("stage_not_next", `Stage "${stage}" is not next for task ${task.id} (next: ${expected ?? "none"}).`);
    }
  };

  switch (event.kind) {
    case "pause": {
      const { stage, runner, reset } = event;
      if (stage === "review") {
        if (task.status !== "DESIGNED" || task.approval !== "model") {
          throw new DevflowError("stage_not_next", `Review is not next for task ${task.id}.`);
        }
      } else {
        checkNext(stage);
      }
      t.pause = { stage, runner, reason: "usage_limit", at: now, ...(reset === undefined ? {} : { reset }) };
      t.history.push({
        kind: "pause", at: now, reason: "usage_limit",
        ...(stage === "review" ? { results: "review" } : { stage }),
        ...(reset === undefined ? {} : { to: reset }),
      });
      return t;
    }
    case "dirty_snapshot": {
      if (!t.dirtyAtImplement) {
        t.dirtyAtImplement = { at: now, paths: { ...event.paths } };
        t.history.push({ kind: "dirty", at: now, results: `${Object.keys(event.paths).length} paths` });
      }
      return t;
    }
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
      /** Extract a stable bracketed conflict key or normalize a legacy free-text reason. */
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
