/** @file Translate role contracts into vendor invocations and verify declared output artifacts. */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, Role } from "./config.js";
import { DevflowError } from "./errors.js";
import type { Scope } from "./hook.js";
import { detectUsageLimit, type UsageLimit } from "./limits.js";
import { openLog } from "./logs.js";
import { API_KEY_VARS, buildChildEnv, launch } from "./proc.js";
import { selfScript } from "./jobs.js";

/** Degree of write-scope enforcement provided by the selected runner. */
export type ScopeMode = "enforced" | "sandbox" | "advisory";

/** Task context, tool permissions and artifact expectations for one role call. */
export interface RunRequest {
  /** Project root that owns the task configuration and logs. */
  root: string;
  /** Logical role label used for log filenames and reports. */
  roleName: string;
  /** Runner, model and optional command template selected for this call. */
  role: Role;
  /** Validated settings used to configure the child environment and runner. */
  config: Config;
  /** Complete role instruction delivered to the child. */
  prompt: string;
  /** Project-relative write patterns granted to this invocation. */
  write: string[];
  /** Shell commands authorized for this role where supported by the runner. */
  bash: string[];
  /** Paths that must be fresh, regular and nonempty after the call. */
  expect: string[];
  /** Role execution deadline in milliseconds. */
  timeoutMs: number;
  /** Task ID used to group logs; standalone calls have no task ID. */
  task?: string;
  /** Environment from which the runner allowlist is derived. */
  parentEnv?: NodeJS.ProcessEnv;
  /** Where the role works (defaults to root). Logs always go to root/.devflow. */
  cwd?: string;
  /** Extra text written beside the log (for example the composed prompt). */
  savePrompt?: boolean;
}

/** Evidence returned by one model invocation for stage classification. */
export interface RunResult {
  /** Whether the runner completed successfully and met the output contract. */
  ok: boolean;
  /** Logical role name used for the invocation. */
  role: string;
  /** Vendor or custom command that executed the role. */
  runner: Role["runner"];
  /** Model identifier selected in configuration. */
  model: string;
  /** Child process status, or null when unavailable. */
  exitCode: number | null;
  /** Wall-clock duration of the invocation in milliseconds. */
  durationMs: number;
  /** Whether the deadline triggered process termination. */
  timedOut: boolean;
  /** Expected paths that were missing, stale, empty, nonregular or outside the project. */
  missingOutputs: { path: string; problem: "missing" | "stale" | "empty" | "not_a_file" | "outside_project" }[];
  /** Effective enforcement mode of this runner. */
  scope: ScopeMode;
  /** Whether vendor API keys were eligible for propagation to the role. */
  apiKeyEnv: "stripped" | "kept";
  /** Location of the redacted process log. */
  log: string;
  /** Classified provider limit that can pause the current stage. */
  usageLimit?: UsageLimit;
  /** The timeout kill could not be confirmed; descendants may still be running. */
  killFailed?: boolean;
  /** Set when the role could not be launched at all (for example cli_not_found). */
  error?: string;
}

/** What a runner needs to launch: command, args and how the scope is applied. */
export interface Invocation {
  /** Name of the executable to launch. */
  command: string;
  /** Ordered command arguments before platform-specific quoting. */
  args: string[];
  /** Effective model for enforcing the requested permissions. */
  scope: ScopeMode;
  /** Files to write before launch (path → content). */
  files?: Record<string, string>;
}



/** Construct the Claude CLI arguments and tool allowlist for a role. */
export function claudeInvocation(req: Pick<RunRequest, "role" | "write" | "bash">, settingsPath: string): Invocation {
  const allowed = ["Read", "Grep", "Glob"];
  for (const g of req.write) allowed.push(`Edit(${g})`, `Write(${g})`, `MultiEdit(${g})`);
  for (const c of req.bash) allowed.push(`Bash(${c})`);
  const args = [
    "-p",
    "--model", req.role.model,
    "--output-format", "json",
    "--permission-mode", "dontAsk",
    "--no-session-persistence",
    "--settings", settingsPath,
    "--allowedTools", ...allowed,
  ];
  if (!req.bash.length) args.push("--disallowedTools", "Bash");
  return { command: "claude", args, scope: "enforced" };
}

/** Build the settings JSON that invokes the devflow scope hook before tool use. */
export function claudeSettings(scopePath: string, node = process.execPath, cliJs = selfScript()): string {
  /** Quote one executable or path component in the generated hook command. */
  const q = (s: string) => `"${s}"`;
  const command = [q(node), q(cliJs), "hook", "pre-tool-use", "--scope-file", q(scopePath)].join(" ");
  return JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command }] }] } }, null, 2);
}

/** Construct a Codex exec command using read-only or workspace-write mode for the chosen directory. */
export function codexInvocation(req: Pick<RunRequest, "role" | "write" | "root"> & { cwd?: string }, ignoreUserConfig: boolean): Invocation {
  const args = [
    "exec",
    "-m", req.role.model,
    "-s", req.write.length ? "workspace-write" : "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "-C", req.cwd ?? req.root,
  ];
  if (ignoreUserConfig) args.push("--ignore-user-config");
  args.push("-");
  return { command: "codex", args, scope: "sandbox" };
}

/** Recognize supported substitutions in custom runner command arguments. */
const PLACEHOLDER = /\{([^}]*)\}/g;

/** Split a template into argv (double or single quotes group words; no shell) and expand placeholders. */
export function commandInvocation(template: string, values: { model: string; prompt_file: string; cwd: string }): Invocation {
  for (const m of template.matchAll(PLACEHOLDER)) {
    if (!["model", "prompt_file", "cwd"].includes(m[1]!)) {
      throw new DevflowError("invalid_template", `Unknown placeholder {${m[1]}} in command template.`);
    }
  }
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of template.matchAll(re)) tokens.push(m[1] ?? m[2] ?? m[3]!);
  const expanded = tokens.map((t) => t.replace(PLACEHOLDER, (_, k: keyof typeof values) => values[k]));
  const [command, ...args] = expanded;
  if (!command) throw new DevflowError("invalid_template", "Empty command template.");
  return { command, args, scope: "advisory" };
}

/** Pre-run existence and content fingerprint for a single expected artifact. */
interface Snapshot {
  /** Whether a filesystem entry was present at the expected path. */
  exists: boolean;
  /** Byte length when the entry was a regular file. */
  size?: number;
  /** Content digest used to detect unchanged output of the same size. */
  hash?: string;
}

/** Compute a SHA-256 digest of an expected artifact's bytes. */
function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Resolve an expected artifact to a path strictly beneath the working root. */
function insideRoot(root: string, p: string): string | undefined {
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const rel = relative(resolve(root), abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) return undefined;
  return abs;
}

/** Capture a regular file's size and hash, or its absence, before launching a role. */
function snapshot(root: string, p: string): Snapshot {
  const abs = insideRoot(root, p);
  if (!abs) return { exists: false };
  try {
    const st = lstatSync(abs);
    if (!st.isFile()) return { exists: true };
    return { exists: true, size: st.size, hash: hashFile(abs) };
  } catch {
    return { exists: false };
  }
}

/** Classify expected artifacts after execution, comparing their bytes with the pre-run snapshot. */
export function checkOutputs(root: string, expect: string[], before: Map<string, Snapshot>): RunResult["missingOutputs"] {
  const problems: RunResult["missingOutputs"] = [];
  for (const p of expect) {
    const abs = insideRoot(root, p);
    if (!abs) {
      problems.push({ path: p, problem: "outside_project" });
      continue;
    }
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      problems.push({ path: p, problem: "missing" });
      continue;
    }
    if (!st.isFile()) problems.push({ path: p, problem: "not_a_file" });
    else if (st.size === 0) problems.push({ path: p, problem: "empty" });
    else {
      const prev = before.get(p);
      if (prev?.exists && prev.size === st.size && prev.hash === hashFile(abs)) problems.push({ path: p, problem: "stale" });
    }
  }
  return problems;
}

/** Reject unsafe write patterns or shell permissions on an invocation with no write scope. */
export function validateScope(write: string[], bash: string[]): void {
  if (!write.length && bash.length) {
    throw new DevflowError("invalid_scope", "A read-only run (no --write) cannot be given shell commands.");
  }
  for (const g of write) {
    if (isAbsolute(g) || /^[A-Za-z]:/.test(g) || g.split(/[\\/]/).includes("..")) {
      throw new DevflowError("invalid_scope", `Write glob "${g}" must be relative to the project and must not contain "..".`);
    }
  }
}

/** Names allowed through to the child: configured pass list, minus every vendor API key unless opted in. */
export function passNames(config: Config, runner: Role["runner"]): { names: string[]; apiKeyEnv: "stripped" | "kept" } {
  const allKeys: string[] = [...API_KEY_VARS.claude, ...API_KEY_VARS.codex];
  /** Identify vendor API key names case-insensitively when filtering opt-in settings. */
  const isKey = (n: string) => allKeys.some((k) => k.toUpperCase() === n.toUpperCase());
  const names = config.runners.env.pass.filter((n) => !isKey(n));
  const optIn =
    (runner === "claude" && config.runners.claude.use_api_key) || (runner === "codex" && config.runners.codex.use_api_key);
  if (optIn && (runner === "claude" || runner === "codex")) names.push(...API_KEY_VARS[runner]);
  return { names, apiKeyEnv: optIn ? "kept" : "stripped" };
}

/** Run one role once. */
export async function runRole(req: RunRequest): Promise<RunResult> {
  validateScope(req.write, req.bash);
  const runnerSettings = req.config.runners;
  // Validate the command template before creating any file.
  if (req.role.runner === "command") commandInvocation(req.role.command, { model: "", prompt_file: "", cwd: "" });
  const log = openLog(req.root, req.roleName, req.task);
  const prefix = log.path.replace(/\.log$/, "");
  const workDir = req.cwd ?? req.root;
  if (req.savePrompt) writeFileSync(`${prefix}.prompt.txt`, req.prompt, { flag: "wx" });

  let inv: Invocation;
  let launched;
  let before: Map<string, Snapshot>;
  const { names, apiKeyEnv } = passNames(req.config, req.role.runner);
  try {
    switch (req.role.runner) {
      case "claude": {
        const scopePath = `${prefix}.scope.json`;
        const settingsPath = `${prefix}.settings.json`;
        const scope: Scope = { root: resolve(workDir), write: req.write, bash: req.bash };
        writeFileSync(scopePath, JSON.stringify(scope, null, 2), { flag: "wx" });
        writeFileSync(settingsPath, claudeSettings(scopePath), { flag: "wx" });
        inv = claudeInvocation(req, settingsPath);
        break;
      }
      case "codex":
        inv = codexInvocation(req, runnerSettings.codex.ignore_user_config);
        break;
      case "command": {
        const promptFile = `${prefix}.prompt.md`;
        writeFileSync(promptFile, req.prompt, { flag: "wx" });
        inv = commandInvocation(req.role.command, { model: req.role.model, prompt_file: promptFile, cwd: workDir });
        break;
      }
    }
    const env = buildChildEnv(req.parentEnv ?? process.env, names);
    before = new Map(req.expect.map((p) => [p, snapshot(workDir, p)] as const));
    launched = await launch({
      command: inv.command,
      args: inv.args,
      cwd: workDir,
      env,
      stdin: req.prompt,
      timeoutMs: req.timeoutMs,
      onOutput: (c, stream) => log.write(c, stream),
    });
  } finally {
    log.close();
  }
  const missingOutputs = checkOutputs(workDir, req.expect, before);
  const runner = req.role.runner;
  const usageLimit = runner === "claude" || runner === "codex"
    ? detectUsageLimit(runner, readFileSync(log.path, "utf8"), launched.exitCode)
    : undefined;
  const result: RunResult = {
    ok: !usageLimit && launched.exitCode === 0 && !launched.timedOut && missingOutputs.length === 0,
    role: req.roleName,
    runner: req.role.runner,
    model: req.role.model,
    exitCode: launched.exitCode,
    durationMs: launched.durationMs,
    timedOut: launched.timedOut,
    missingOutputs,
    scope: inv.scope,
    apiKeyEnv,
    log: log.path,
    ...(usageLimit ? { usageLimit } : {}),
  };
  if (launched.killFailed) result.killFailed = true;
  return result;
}
