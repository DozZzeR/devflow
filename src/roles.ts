import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, DEVFLOW_DIR, parseConfig, type Config, type Role } from "./config.js";
import { DevflowError } from "./errors.js";
import { buildChildEnv, resolveCommand } from "./proc.js";
import { runRole } from "./runners.js";
import { writeFileAtomic } from "./store.js";

export interface Candidate {
  runner: "claude" | "codex";
  model: string;
}

/** One cross-vendor ranking, strongest first. Data, not logic: update it when model line-ups change. */
export const RANKING: Candidate[] = [
  { runner: "claude", model: "fable" },
  { runner: "claude", model: "opus" },
  { runner: "codex", model: "gpt-6.2-sol" },
  { runner: "claude", model: "sonnet" },
  { runner: "codex", model: "gpt-5.6-terra" },
  { runner: "claude", model: "haiku" },
  { runner: "codex", model: "gpt-5.6-luna" },
];

export const ROLE_NAMES = ["explore", "design", "design_complex", "review", "implement", "small", "verify"] as const;

const key = (c: Candidate) => `${c.runner}/${c.model}`;

export interface Proposal {
  roles: Record<(typeof ROLE_NAMES)[number], Candidate>;
  candidates: Candidate[];
  warnings: string[];
}

/** Assign roles from ranked candidates (strongest first). */
export function proposeLayout(candidates: Candidate[]): Proposal {
  if (!candidates.length) throw new DevflowError("no_models", "No usable model: install claude or codex, or check the probes.");
  const c = candidates;
  const strongest = c[0]!;
  const design = c.find((x) => x.model !== "fable") ?? strongest;
  const implement = c[Math.min(2, c.length - 1)]!;
  const explore = c[c.length - 1]!;
  const warnings: string[] = [];
  const others = c.filter((x) => key(x) !== key(implement));
  let verify = others.find((x) => x.runner !== implement.runner) ?? others[0];
  if (!verify) {
    verify = implement;
    warnings.push("verify_not_independent");
  }
  return {
    roles: { explore, design, design_complex: strongest, review: strongest, implement, small: implement, verify },
    candidates: c,
    warnings,
  };
}

async function probe(root: string, config: Config, c: Candidate, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const r = await runRole({
      root,
      roleName: "probe_roles",
      role: { runner: c.runner, model: c.model },
      config,
      prompt: "Reply with exactly one word: OK",
      write: [],
      bash: [],
      expect: [],
      timeoutMs: 120_000,
      parentEnv: env,
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Ranked candidates whose CLI is installed and, when probing, that answer a minimal call. */
export async function candidates(root: string, config: Config, opts: { probe?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<Candidate[]> {
  const env = opts.env ?? process.env;
  const childEnv = buildChildEnv(env);
  const installed = new Set((["claude", "codex"] as const).filter((r) => resolveCommand(r, childEnv)));
  const out: Candidate[] = [];
  for (const c of RANKING.filter((x) => installed.has(x.runner))) {
    if (!opts.probe || (await probe(root, config, c, env))) out.push(c);
  }
  return out;
}

function readRaw(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, DEVFLOW_DIR, CONFIG_FILE), "utf8")) as Record<string, unknown>;
}

/** Validate the edited config and write it atomically; an invalid result leaves the file unchanged. */
function writeRoles(root: string, roles: Record<string, unknown>): Config {
  const raw = readRaw(root);
  raw.roles = { ...(raw.roles as Record<string, unknown>), ...roles };
  const config = parseConfig(raw);
  writeFileAtomic(join(root, DEVFLOW_DIR, CONFIG_FILE), JSON.stringify(raw, null, 2) + "\n");
  return config;
}

export function applyProposal(root: string, p: Proposal): Config {
  return writeRoles(root, p.roles);
}

export function setRole(root: string, role: string, runner: string, model: string, command?: string): Config {
  if (!(ROLE_NAMES as readonly string[]).includes(role)) {
    throw new DevflowError("invalid_config", `Unknown role "${role}" (roles: ${ROLE_NAMES.join(", ")}).`);
  }
  const value: Record<string, string> = { runner, model };
  if (command !== undefined) value.command = command;
  return writeRoles(root, { [role]: value });
}

export function showRoles(config: Config): Record<string, Role> {
  return Object.fromEntries(Object.entries(config.roles).filter((e): e is [string, Role] => e[1] !== undefined));
}
