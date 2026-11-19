#!/usr/bin/env node
/** @file Dispatch CLI commands, translate errors to exit codes and expose the same entry point to MCP. */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { findProjectRoot, initProject, loadConfig, type Config, type RunnerMode } from "./config.js";
import { doctor } from "./doctor.js";
import { runHook } from "./hook.js";
import { resolveCommand } from "./proc.js";
import { runRole } from "./runners.js";
import { GATE_NAMES, gateConfig, runAllGates, runGate, type GateName } from "./gates.js";
import { git, headCommit, repoInfo } from "./git.js";
import { validateZone, zoneFromDesign } from "./zone.js";
import { checkDesign } from "./artifacts.js";
import { adoptLock, acquireLock, latestRunLog, newRunId, readLock, releaseLock, startDetached } from "./background.js";
import { changeFiles, changeFolder, planDigest } from "./snapshot.js";
import { runGatesStage, runLoop } from "./stages.js";
import { finishJob } from "./jobs.js";
import { applyProposal, candidates, proposeLayout, setRole, showRoles } from "./roles.js";
import { planNodes } from "./plan-nodes.js";
import { DevflowError, UsageError } from "./errors.js";
import { newTask, nextStage, STAGES, TIERS, transition, type Event, type Stage, type TaskState, type Tier } from "./lifecycle.js";
import { createTask, listTaskIds, loadTask, saveTask, validateId } from "./store.js";

/** Help text emitted for the CLI entry point. */
const USAGE = `devflow — role-separated dev workflow

Usage:
  devflow init [--dir <path>] [--runners mixed|claude|codex]
  devflow start <id> "<description>" [--tier small|medium|complex] [--tracker <ref>] [--zone <glob>]...
  devflow nodes <id> [--json]
  devflow next <id>
  devflow complete <id> <stage> <outcome> [--override "<reason>"]   (gates ok needs --override)
  devflow approve <id> [--resume | --reject "<what to change>" [--node <task-id>] [--revision <n>]]
  devflow tier <id> <small|medium|complex>
  devflow escalate <id> --reason "<why>"
  devflow status [<id>] [--json]
  devflow exec-role <role> --prompt-file <file> [--write <glob>]... [--allow-bash <cmd>]...
                    [--expect <path>]... [--timeout <seconds>] [--task <id>]
  devflow doctor [--probe] [--json]
  devflow zone <id> (--from-design <file> | --zone <glob>...)
  devflow base <id> <commit>
  devflow gate <id> [zone|tests|rollback|all]
  devflow run <id> [--once] [--detach] [--timeout <seconds>]
  devflow delegate-approval <id> --to model|human
  devflow roles [--json] | roles propose [--probe] [--apply] | roles set <role> <runner> <model> [--command "<template>"]
  devflow mcp
  devflow log <id> [--follow]

Global: --json (machine-readable errors), --help, --version`;

/** Positional arguments, single-value switches and repeatable options from one invocation. */
interface Parsed {
  /** Command and operands in their original order. */
  positional: string[];
  /** Boolean and single-value switches keyed by option name. */
  flags: Map<string, string | true>;
  /** Values of repeatable switches in input order. */
  lists: Map<string, string[]>;
}

/** Switches consuming one inline or following argument. */
const VALUE_FLAGS = new Set(["dir", "tier", "tracker", "reason", "runners", "prompt-file", "timeout", "task", "scope-file", "override", "from-design", "run-id", "reject", "node", "revision", "to", "command"]);
/** Switches accumulating multiple values across occurrences. */
const LIST_FLAGS = new Set(["write", "expect", "allow-bash", "zone"]);
/** Switches enabled by their presence. */
const BOOL_FLAGS = new Set(["json", "resume", "help", "version", "probe", "once", "detach", "follow", "apply"]);

/** Parse long options and preserve command operands. Unknown options and missing values raise UsageError. */
export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const lists = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
      if (VALUE_FLAGS.has(name) || LIST_FLAGS.has(name)) {
        const value = inline ?? argv[++i];
        if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value`);
        if (LIST_FLAGS.has(name)) lists.set(name, [...(lists.get(name) ?? []), value]);
        else flags.set(name, value);
      } else if (BOOL_FLAGS.has(name)) {
        flags.set(name, true);
      } else {
        throw new UsageError(`Unknown option --${name}`);
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags, lists };
}

/** Return a string-valued option or undefined when the switch has no string value. */
function str(p: Parsed, name: string): string | undefined {
  const v = p.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

/** Enforce the permitted operand count before dispatching a command. */
function arity(args: string[], min: number, max: number, usage: string): void {
  if (args.length < min || args.length > max) throw new UsageError(`Usage: devflow ${usage}`);
}

/** Validate a CLI tier name and report a usage error for unsupported values. */
function asTier(value: string): Tier {
  if (!(TIERS as readonly string[]).includes(value)) throw new UsageError(`Tier must be one of: ${TIERS.join(", ")}`);
  return value as Tier;
}

/** Validate a CLI stage name before recording a manual completion. */
function asStage(value: string): Stage {
  if (!(STAGES as readonly string[]).includes(value)) throw new UsageError(`Stage must be one of: ${STAGES.join(", ")}`);
  return value as Stage;
}

/** Set by the plugin bundler; absent when running from dist/. */
declare const __DEVFLOW_VERSION__: string | undefined;

/** Read the embedded bundle version or the development package version. */
function version(): string {
  if (typeof __DEVFLOW_VERSION__ !== "undefined") return __DEVFLOW_VERSION__;
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8")) as { version: string };
  return pkg.version;
}

/** Host boundary used to run a command from the terminal, MCP or tests. */
export interface Io {
  /** Starting directory for project discovery. */
  cwd: string;
  /** Parent environment available to runner and process adapters. */
  env: NodeJS.ProcessEnv;
  /** Supply the complete prompt or hook event when requested by the command. */
  readStdin: () => Promise<string>;
  /** Receive one piece of normal command output. */
  out: (s: string) => void;
  /** Receive formatted usage and operational errors. */
  err: (s: string) => void;
  /** Supply a timestamp for state transitions and run metadata. */
  now: () => string;
}

/** Find the project above the caller's directory and validate its configuration. */
function project(io: Io): { root: string; config: Config } {
  const root = findProjectRoot(io.cwd);
  return { root, config: loadConfig(root) };
}

/** Load a task, apply one lifecycle event and persist its resulting state. */
function apply(io: Io, id: string, event: Event): TaskState {
  const { root, config } = project(io);
  const task = loadTask(root, id);
  const next = transition(task, event, config, io.now());
  saveTask(root, next);
  return next;
}

/** Project stored state and the next-stage decision into the CLI status response. */
function summary(task: TaskState, config: Config) {
  const n = nextStage(task, config);
  return {
    id: task.id,
    tier: task.tier,
    status: task.status,
    next: n.stage,
    reason: n.reason ?? null,
    tracker: task.tracker ?? null,
    attempts: task.attempts,
    escalations: task.history.filter((h) => h.kind === "escalate" || h.kind === "tier"),
  };
}

/** Dispatch one invocation using the supplied host I/O and return its process exit code. */
export async function run(argv: string[], io: Io): Promise<number> {
  if (argv[0] === "__job") {
    // Internal: run a command as a background job and record its exit code.
    const [, jobId, ...rest] = argv;
    const code = await run(rest, io);
    try {
      finishJob(findProjectRoot(io.cwd), jobId ?? "", code);
    } catch {
      /* the job record is best effort */
    }
    return code;
  }
  let json = argv.includes("--json");
  try {
    const p = parseArgs(argv);
    json = p.flags.has("json");
    if (p.flags.has("version")) {
      io.out(version());
      return 0;
    }
    const [command, ...args] = p.positional;
    if (!command || p.flags.has("help")) {
      io.out(USAGE);
      return command || p.flags.has("help") ? 0 : 2;
    }

    switch (command) {
      case "init": {
        arity(args, 0, 0, "init [--dir <path>] [--runners mixed|claude|codex]");
        const runners = str(p, "runners");
        if (runners !== undefined && !["mixed", "claude", "codex"].includes(runners)) {
          throw new UsageError("--runners must be one of: mixed, claude, codex");
        }
        const detected = { claude: !!resolveCommand("claude", io.env), codex: !!resolveCommand("codex", io.env) };
        const r = initProject(str(p, "dir") ?? io.cwd, runners ? { runners: runners as RunnerMode, detected } : { detected });
        if (json) io.out(JSON.stringify(r));
        else {
          io.out(r.configCreated ? `Created ${r.root}/.devflow/config.json (runners: ${r.runners})` : `.devflow/config.json already exists in ${r.root}; left unchanged.`);
          if (r.gitignore !== "unchanged") io.out(`${r.gitignore === "created" ? "Created" : "Updated"} ${r.root}/.devflow/.gitignore`);
        }
        for (const w of r.warnings) io.err(`devflow: warning: ${w}`);
        return 0;
      }
      case "start": {
        arity(args, 2, 2, 'start <id> "<description>" [--tier t] [--tracker ref]');
        const [id, description] = args as [string, string];
        validateId(id);
        const tier = asTier(str(p, "tier") ?? "medium");
        const { root, config } = project(io);
        const task = newTask(id, description, tier, str(p, "tracker"), io.now());
        const zone = p.lists.get("zone");
        if (zone) {
          validateZone(zone);
          task.zone = zone;
        }
        if (repoInfo(root)) {
          const head = headCommit(root);
          if (head) task.base = head;
        }
        createTask(root, task);
        io.out(json ? JSON.stringify(summary(task, config)) : `Started ${id} (${tier}). Next: ${nextStage(task, config).stage}`);
        return 0;
      }
      case "nodes": {
        arity(args, 1, 1, "nodes <id>");
        const { root } = project(io);
        const task = loadTask(root, args[0]!);
        const path = join(changeFolder(root, task.id), "tasks.md");
        const markdown = existsSync(path) ? readFileSync(path, "utf8") : "";
        const nodes = [...planNodes(markdown)].map(([id, n]) => ({ id, done: n.done, text: markdown.slice(n.start, n.end) }));
        io.out(JSON.stringify({ id: task.id, revision: task.planRevision ?? 1, nodes }));
        return 0;
      }
      case "next": {
        arity(args, 1, 1, "next <id>");
        const { root, config } = project(io);
        io.out(JSON.stringify(nextStage(loadTask(root, args[0]!), config)));
        return 0;
      }
      case "complete": {
        arity(args, 3, 3, "complete <id> <stage> <outcome>");
        const [id, stage, outcome] = args as [string, string, string];
        if (stage === "verify" && outcome === "pass" && !str(p, "override")) {
          throw new DevflowError("verify_needs_run", `Record verify with "devflow run ${id}", or use --override "<reason>".`);
        }
        const override = str(p, "override");
        const t = apply(io, id, { kind: "complete", stage: asStage(stage), outcome, ...(override ? { override } : {}) });
        const { config } = project(io);
        io.out(JSON.stringify(nextStage(t, config)));
        return 0;
      }
      case "approve": {
        arity(args, 1, 1, "approve <id> [--resume]");
        const rejectReason = str(p, "reject");
        const revisionArg = str(p, "revision");
        const revision = revisionArg === undefined ? undefined : Number(revisionArg);
        if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) throw new UsageError("--revision must be a positive integer");
        const node = str(p, "node");
        if (node) {
          if (!rejectReason || p.flags.has("resume") || revision === undefined) throw new UsageError("--node requires --reject and --revision");
          const { root } = project(io);
          validateId(args[0]!);
          const path = join(changeFolder(root, args[0]!), "tasks.md");
          if (!planNodes(readFileSync(path, "utf8")).has(node)) throw new DevflowError("unknown_plan_node", "Unknown plan node " + node);
        }
        const rev = revision === undefined ? {} : { revision };
        let event: Event = p.flags.has("resume") ? { kind: "resume" } : rejectReason ? { kind: "reject", reason: rejectReason, ...(node ? { node } : {}), ...rev } : { kind: "approve", ...rev };
        if (!p.flags.has("resume") && !rejectReason) {
          const { root, config } = project(io);
          const id = args[0]!;
          validateId(id);
          const current = loadTask(root, id);
          if (current.status !== "DESIGNED") {
            throw new DevflowError("not_awaiting_approval", `Task ${id} is not awaiting plan approval (status: ${current.status}).`);
          }
          if (revision !== undefined && revision !== (current.planRevision ?? 1)) {
            throw new DevflowError("plan_moved", `Revision ${revision} is not the current plan (revision ${current.planRevision ?? 1}).`);
          }
          // With a plan folder, approval re-checks the design and binds the plan and its zone.
          const designedByRun = loadTask(root, id).history.some((h) => h.kind === "complete" && h.stage === "design" && h.outcome === "ok" && h.results === "run");
          if (designedByRun && !changeFiles(root, id).length) {
            throw new DevflowError("plan_missing", `The plan folder openspec/changes/${id}/ is missing; run design again (approve --reject) instead of approving.`);
          }
          if (changeFiles(root, id).length) {
            const check = await checkDesign(root, id, config);
            if (!check.ok) throw new DevflowError("design_invalid", `Plan for ${id} does not pass the design checks: ${check.reason}`, check.details);
            event = { kind: "approve", planDigest: planDigest(root, id, loadTask(root, id).planRevision ?? 1), zone: check.zone!, ...rev };
          }
        }
        const t = apply(io, args[0]!, event);
        const { config } = project(io);
        io.out(JSON.stringify(nextStage(t, config)));
        return 0;
      }
      case "tier": {
        arity(args, 2, 2, "tier <id> <tier>");
        const t = apply(io, args[0]!, { kind: "tier", tier: asTier(args[1]!) });
        const { config } = project(io);
        io.out(JSON.stringify(nextStage(t, config)));
        return 0;
      }
      case "escalate": {
        arity(args, 1, 1, 'escalate <id> --reason "<why>"');
        const reason = str(p, "reason");
        if (!reason) throw new UsageError("escalate needs --reason");
        const t = apply(io, args[0]!, { kind: "escalate", reason });
        const { config } = project(io);
        io.out(JSON.stringify(nextStage(t, config)));
        return 0;
      }
      case "status": {
        arity(args, 0, 1, "status [<id>] [--json]");
        const { root, config } = project(io);
        const ids = args.length ? [args[0]!] : listTaskIds(root);
        const rows = ids.map((id) => summary(loadTask(root, id), config));
        if (json) io.out(JSON.stringify(args.length ? rows[0] : rows));
        else if (!rows.length) io.out("No tasks.");
        else {
          for (const r of rows) {
            const next = r.next ?? `(${r.reason})`;
            const a = r.attempts;
            io.out(`${r.id}  ${r.tier}  ${r.status}  next: ${next}  attempts: impl ${a.implement}, verify ${a.verify}${r.tracker ? `  [${r.tracker}]` : ""}`);
            for (const e of r.escalations) io.out(`    ${e.at}  ${e.kind} ${e.from} → ${e.to}${e.reason ? `: ${e.reason}` : ""}`);
            const lock = readLock(root, r.id);
            if (lock) io.out(`    run ${lock.runId} ${lock.status}${lock.pid ? ` pid ${lock.pid}` : ""}${lock.log ? `  log: ${lock.log}` : ""}`);
          }
        }
        return 0;
      }
      case "exec-role": {
        arity(args, 1, 1, "exec-role <role> --prompt-file <file> [--write <glob>]... [--expect <path>]...");
        const roleName = args[0]!;
        const promptFile = str(p, "prompt-file");
        if (!promptFile) throw new UsageError("exec-role needs --prompt-file");
        const timeout = str(p, "timeout");
        const timeoutSec = timeout === undefined ? 1800 : Number(timeout);
        if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw new UsageError("--timeout must be a positive number of seconds");
        const { root, config } = project(io);
        const role = (config.roles as Record<string, Config["roles"]["explore"] | undefined>)[roleName];
        if (!role) throw new DevflowError("unknown_role", `Role "${roleName}" is not configured.`);
        const task = str(p, "task");
        if (task !== undefined) validateId(task);
        let prompt: string;
        try {
          prompt = readFileSync(promptFile, "utf8");
        } catch {
          throw new DevflowError("no_prompt", `Cannot read prompt file ${promptFile}.`);
        }
        const result = await runRole({
          root,
          roleName,
          role,
          config,
          prompt,
          write: p.lists.get("write") ?? [],
          bash: p.lists.get("allow-bash") ?? [],
          expect: p.lists.get("expect") ?? [],
          timeoutMs: timeoutSec * 1000,
          parentEnv: io.env,
          ...(task !== undefined ? { task } : {}),
        });
        io.out(JSON.stringify(result));
        return result.ok ? 0 : 1;
      }
      case "doctor": {
        arity(args, 0, 0, "doctor [--probe] [--json]");
        const { root, config } = project(io);
        const report = await doctor(root, config, p.flags.has("probe"), io.env);
        if (json) io.out(JSON.stringify(report));
        else {
          for (const c of report.clis) io.out(`${c.name}: ${c.path ? `${c.version ?? "?"} (${c.path}), login: ${c.login}` : "not installed"}`);
          for (const m of report.missing) io.out(`role ${m.role} needs ${m.runner}, which is not installed`);
          for (const pr of report.probes ?? []) io.out(`probe ${pr.runner}/${pr.model}: ${pr.ok ? "ok" : "FAILED"} in ${pr.durationMs} ms${pr.detail ? ` (${pr.detail})` : ""}`);
        }
        const failed = report.missing.length > 0 || (report.probes ?? []).some((x) => !x.ok);
        return failed ? 1 : 0;
      }
      case "zone": {
        arity(args, 1, 1, "zone <id> (--from-design <file> | --zone <glob>...)");
        const { root, config } = project(io);
        const task = loadTask(root, args[0]!);
        const design = str(p, "from-design");
        const listed = p.lists.get("zone");
        if (!!design === !!listed) throw new UsageError("zone needs exactly one of --from-design <file> or --zone <glob>...");
        const zone = design ? zoneFromDesign(design) : listed!;
        validateZone(zone);
        task.zone = zone;
        task.updatedAt = io.now();
        task.history.push({ at: task.updatedAt, kind: "zone", reason: zone.join(", ") });
        saveTask(root, task);
        io.out(JSON.stringify({ id: task.id, zone }));
        void config;
        return 0;
      }
      case "base": {
        arity(args, 2, 2, "base <id> <commit>");
        const { root } = project(io);
        const task = loadTask(root, args[0]!);
        if (!repoInfo(root)) throw new DevflowError("no_git", `${root} is not inside a git repository.`);
        const r = git(root, ["rev-parse", "--verify", "--end-of-options", `${args[1]!}^{commit}`], { allowFail: true });
        if (r.code !== 0) throw new DevflowError("invalid_commit", `"${args[1]}" is not a commit.`);
        task.base = r.stdout.trim();
        task.updatedAt = io.now();
        task.history.push({ at: task.updatedAt, kind: "base", reason: task.base });
        saveTask(root, task);
        io.out(JSON.stringify({ id: task.id, base: task.base }));
        return 0;
      }
      case "gate": {
        arity(args, 1, 2, "gate <id> [zone|tests|rollback|all]");
        const which = args[1] ?? "all";
        if (which !== "all" && !(GATE_NAMES as readonly string[]).includes(which)) {
          throw new UsageError(`Gate must be one of: ${GATE_NAMES.join(", ")}, all`);
        }
        const { root, config: workingConfig } = project(io);
        const task = loadTask(root, args[0]!);
        const { config, source: configSource } = gateConfig(root, task.base, workingConfig);
        const ctx = { root, task, config, parentEnv: io.env };
        let recorded = false;
        let out: Record<string, unknown>;
        if (which === "all") {
          if (nextStage(task, workingConfig).stage === "gates") {
            const gateRun = newRunId();
            acquireLock(root, task.id, { runId: gateRun, status: "running", startedAt: io.now(), pid: process.pid });
            let g;
            try {
              g = await runGatesStage(root, task, workingConfig, { now: io.now, env: io.env });
            } finally {
              releaseLock(root, task.id, gateRun);
            }
            out = { id: task.id, results: g.results, skipped: g.skipped, next: nextStage(g.task, workingConfig) };
            recorded = true;
          } else {
            const { results, skipped } = await runAllGates(ctx);
            out = { id: task.id, results, skipped };
          }
        } else {
          out = { id: task.id, results: [await runGate(which as GateName, ctx)] };
        }
        out.recorded = recorded;
        out.configSource = configSource;
        io.out(JSON.stringify(out));
        const results = out.results as { outcome: string }[];
        return results.every((r) => r.outcome === "pass") ? 0 : 1;
      }
      case "run": {
        arity(args, 1, 1, "run <id> [--once] [--detach] [--timeout <seconds>]");
        const id = args[0]!;
        validateId(id);
        const { root, config } = project(io);
        loadTask(root, id);
        const timeout = str(p, "timeout");
        const timeoutSec = timeout === undefined ? 1800 : Number(timeout);
        if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw new UsageError("--timeout must be a positive number of seconds");
        if (p.flags.has("detach")) {
          const passthrough = [...(p.flags.has("once") ? ["--once"] : []), ...(timeout ? ["--timeout", timeout] : [])];
          const started = startDetached(root, id, passthrough, io.env);
          io.out(JSON.stringify({ id, runId: started.runId, log: started.log, detached: true }));
          return 0;
        }
        const runId = str(p, "run-id") ?? newRunId();
        if (str(p, "run-id")) adoptLock(root, id, runId);
        else acquireLock(root, id, { runId, status: "running", startedAt: io.now(), pid: process.pid });
        try {
          const reports = await runLoop(root, config, id, { now: io.now, env: io.env, timeoutMs: timeoutSec * 1000 }, {
            once: p.flags.has("once"),
            onStage: (r) => io.out(JSON.stringify(r)),
          });
          const final = nextStage(loadTask(root, id), config);
          io.out(JSON.stringify({ id, done: true, stages: reports.length, next: final }));
          const last = reports.at(-1);
          return last && ["fail", "blocked"].includes(last.outcome) ? 1 : 0;
        } finally {
          releaseLock(root, id, runId);
        }
      }
      case "log": {
        arity(args, 1, 1, "log <id> [--follow]");
        const id = args[0]!;
        validateId(id);
        const { root } = project(io);
        const path = latestRunLog(root, id);
        if (!path) throw new DevflowError("no_log", `Task ${id} has no run log yet.`);
        let offset = 0;
        /** Emit newly appended run-log content when a client follows a background run. */
        const dump = () => {
          const text = readFileSync(path, "utf8");
          if (text.length > offset) io.out(text.slice(offset).replace(/\n$/, ""));
          offset = text.length;
        };
        dump();
        if (p.flags.has("follow")) {
          while (readLock(root, id)) {
            await new Promise((r) => setTimeout(r, 1000));
            dump();
          }
          dump();
        }
        return 0;
      }
      case "delegate-approval": {
        arity(args, 1, 1, "delegate-approval <id> --to model|human");
        const to = str(p, "to");
        if (to !== "model" && to !== "human") throw new UsageError("--to must be model or human");
        const t = apply(io, args[0]!, { kind: "delegate", to });
        io.out(JSON.stringify({ id: t.id, approval: t.approval }));
        return 0;
      }
      case "roles": {
        const { root, config } = project(io);
        const sub = args[0];
        if (!sub) {
          const roles = showRoles(config);
          if (json) io.out(JSON.stringify(roles));
          else for (const [name, r] of Object.entries(roles)) io.out(`${name.padEnd(15)} ${r.runner}/${r.model}`);
          return 0;
        }
        if (sub === "propose") {
          arity(args, 1, 1, "roles propose [--probe] [--apply]");
          const proposal = proposeLayout(await candidates(root, config, { probe: p.flags.has("probe"), env: io.env }));
          if (p.flags.has("apply")) applyProposal(root, proposal);
          io.out(JSON.stringify({ ...proposal, applied: p.flags.has("apply") }));
          return 0;
        }
        if (sub === "set") {
          arity(args, 4, 4, 'roles set <role> <runner> <model> [--command "<template>"]');
          const updated = setRole(root, args[1]!, args[2]!, args[3]!, str(p, "command"));
          io.out(JSON.stringify(showRoles(updated)));
          return 0;
        }
        throw new UsageError(`Unknown roles subcommand "${sub}"`);
      }
      case "mcp": {
        arity(args, 0, 0, "mcp");
        const { serveMcp } = await import("./mcp.js");
        await serveMcp({ cwd: str(p, "dir") ?? io.cwd, env: io.env, now: io.now, run });
        return 0;
      }
      case "hook": {
        arity(args, 1, 1, "hook pre-tool-use --scope-file <file>");
        if (args[0] !== "pre-tool-use") throw new UsageError(`Unknown hook "${args[0]}"`);
        const scopeFile = str(p, "scope-file");
        if (!scopeFile) throw new UsageError("hook needs --scope-file");
        io.out(runHook(scopeFile, await io.readStdin()));
        return 0;
      }
      default:
        throw new UsageError(`Unknown command "${command}". Run devflow --help.`);
    }
  } catch (e) {
    if (e instanceof UsageError || e instanceof DevflowError) {
      if (json) io.err(JSON.stringify({ error: { reason: e.reason, message: e.message } }));
      else io.err(`devflow: ${e.message}`);
      return e instanceof UsageError ? 2 : 1;
    }
    throw e;
  }
}

/** Distinguish starting the CLI process from importing its in-process command runner. */
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === (await import("node:fs")).realpathSync(process.argv[1]);
if (invokedDirectly) {
  process.exitCode = await run(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    readStdin: async () => {
      let data = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) data += chunk;
      return data;
    },
    out: (s) => process.stdout.write(s + "\n"),
    err: (s) => process.stderr.write(s + "\n"),
    now: () => new Date().toISOString(),
  });
}
