#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { findProjectRoot, initProject, loadConfig, type Config } from "./config.js";
import { DevflowError, UsageError } from "./errors.js";
import { newTask, nextStage, STAGES, TIERS, transition, type Event, type Stage, type TaskState, type Tier } from "./lifecycle.js";
import { createTask, listTaskIds, loadTask, saveTask, validateId } from "./store.js";

const USAGE = `devflow — role-separated dev workflow

Usage:
  devflow init [--dir <path>]
  devflow start <id> "<description>" [--tier small|medium|complex] [--tracker <ref>]
  devflow next <id>
  devflow complete <id> <stage> <outcome>
  devflow approve <id> [--resume]
  devflow tier <id> <small|medium|complex>
  devflow escalate <id> --reason "<why>"
  devflow status [<id>] [--json]

Global: --json (machine-readable errors), --help, --version`;

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(["dir", "tier", "tracker", "reason"]);
const BOOL_FLAGS = new Set(["json", "resume", "help", "version"]);

export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
      if (VALUE_FLAGS.has(name)) {
        const value = inline ?? argv[++i];
        if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value`);
        flags.set(name, value);
      } else if (BOOL_FLAGS.has(name)) {
        flags.set(name, true);
      } else {
        throw new UsageError(`Unknown option --${name}`);
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function str(p: Parsed, name: string): string | undefined {
  const v = p.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

function arity(args: string[], min: number, max: number, usage: string): void {
  if (args.length < min || args.length > max) throw new UsageError(`Usage: devflow ${usage}`);
}

function asTier(value: string): Tier {
  if (!(TIERS as readonly string[]).includes(value)) throw new UsageError(`Tier must be one of: ${TIERS.join(", ")}`);
  return value as Tier;
}

function asStage(value: string): Stage {
  if (!(STAGES as readonly string[]).includes(value)) throw new UsageError(`Stage must be one of: ${STAGES.join(", ")}`);
  return value as Stage;
}

function version(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8")) as { version: string };
  return pkg.version;
}

export interface Io {
  cwd: string;
  out: (s: string) => void;
  err: (s: string) => void;
  now: () => string;
}

function project(io: Io): { root: string; config: Config } {
  const root = findProjectRoot(io.cwd);
  return { root, config: loadConfig(root) };
}

function apply(io: Io, id: string, event: Event): TaskState {
  const { root, config } = project(io);
  const task = loadTask(root, id);
  const next = transition(task, event, config, io.now());
  saveTask(root, next);
  return next;
}

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

export function run(argv: string[], io: Io): number {
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
        arity(args, 0, 0, "init [--dir <path>]");
        const r = initProject(str(p, "dir") ?? io.cwd);
        if (json) io.out(JSON.stringify(r));
        else {
          io.out(r.configCreated ? `Created ${r.root}/.devflow/config.json` : `.devflow/config.json already exists in ${r.root}; left unchanged.`);
          if (r.gitignoreCreated) io.out(`Created ${r.root}/.devflow/.gitignore`);
        }
        return 0;
      }
      case "start": {
        arity(args, 2, 2, 'start <id> "<description>" [--tier t] [--tracker ref]');
        const [id, description] = args as [string, string];
        validateId(id);
        const tier = asTier(str(p, "tier") ?? "medium");
        const { root, config } = project(io);
        const task = newTask(id, description, tier, str(p, "tracker"), io.now());
        createTask(root, task);
        io.out(json ? JSON.stringify(summary(task, config)) : `Started ${id} (${tier}). Next: ${nextStage(task, config).stage}`);
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
        const t = apply(io, id, { kind: "complete", stage: asStage(stage), outcome });
        const { config } = project(io);
        io.out(JSON.stringify(nextStage(t, config)));
        return 0;
      }
      case "approve": {
        arity(args, 1, 1, "approve <id> [--resume]");
        const t = apply(io, args[0]!, p.flags.has("resume") ? { kind: "resume" } : { kind: "approve" });
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
          }
        }
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

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === (await import("node:fs")).realpathSync(process.argv[1]);
if (invokedDirectly) {
  process.exitCode = run(process.argv.slice(2), {
    cwd: process.cwd(),
    out: (s) => process.stdout.write(s + "\n"),
    err: (s) => process.stderr.write(s + "\n"),
    now: () => new Date().toISOString(),
  });
}
