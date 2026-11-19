/** @file Report CLI availability, authentication summaries and optional live role probes. */

import { readFileSync } from "node:fs";
import type { Config, Role } from "./config.js";
import { buildChildEnv, launch, resolveCommand } from "./proc.js";
import { runRole, type RunResult } from "./runners.js";

/** Result of inspecting one vendor executable and its account status. */
export interface CliStatus {
  /** Vendor command inspected on PATH. */
  name: "claude" | "codex";
  /** Resolved executable, or null if unavailable. */
  path: string | null;
  /** First reported version line, or null when the command fails. */
  version: string | null;
  /** Short account status suitable for display in the diagnostic report. */
  login: string;
}

/** Environment diagnostics for all configured vendor roles. */
export interface DoctorReport {
  /** Status of each known vendor CLI. */
  clis: CliStatus[];
  /** Configured roles whose vendor executable could not be found. */
  missing: { role: string; runner: string }[];
  /** Node version of the running process. */
  node: string;
  /** Optional results of live calls, deduplicated by vendor and model. */
  probes?: { runner: string; model: string; ok: boolean; durationMs: number; log: string; detail?: string }[];
}

/** Run a bounded diagnostic command and collapse output and launch errors into one record. */
async function capture(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number | null; out: string }> {
  let out = "";
  try {
    const r = await launch({ command, args, cwd, env, stdin: "", timeoutMs: 30_000, onOutput: (c) => (out += c) });
    return { code: r.timedOut ? null : r.exitCode, out: out.trim() };
  } catch (e) {
    return { code: null, out: (e as Error).message };
  }
}

/** Pick the first nonblank line for compact diagnostic output. */
function firstLine(s: string): string {
  return s.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
}

/** Summarise login output without personal data (claude prints JSON with email/org). */
export function loginSummary(out: string): string {
  try {
    const j = JSON.parse(out) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
    if (typeof j.loggedIn === "boolean") {
      return j.loggedIn ? `logged in via ${j.authMethod ?? "?"}${j.subscriptionType ? ` (${j.subscriptionType})` : ""}` : "not logged in";
    }
  } catch {
    /* plain text */
  }
  return firstLine(out) || "ok";
}

/** Read a bounded suffix of the last nonblank log line for a probe diagnostic. */
function lastLogLine(path: string): string | undefined {
  try {
    const lines = readFileSync(path, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return lines.at(-1)?.slice(0, 200);
  } catch {
    return undefined;
  }
}

/** Resolve the vendor CLI and collect version and login information with a filtered environment. */
export async function cliStatus(name: "claude" | "codex", cwd: string, parentEnv: NodeJS.ProcessEnv = process.env): Promise<CliStatus> {
  const env = buildChildEnv(parentEnv);
  const path = resolveCommand(name, env) ?? null;
  if (!path) return { name, path, version: null, login: "not installed" };
  const version = await capture(name, ["--version"], env, cwd);
  const login = await capture(name, name === "codex" ? ["login", "status"] : ["auth", "status"], env, cwd);
  return {
    name,
    path,
    version: version.code === 0 ? firstLine(version.out) : null,
    login: login.code === 0 ? loginSummary(login.out) : "unknown",
  };
}

/** Inspect installed CLIs; when probe is enabled, make a read-only call for each distinct vendor/model pair. */
export async function doctor(root: string, config: Config, probe: boolean, parentEnv: NodeJS.ProcessEnv = process.env): Promise<DoctorReport> {
  const clis = [await cliStatus("claude", root, parentEnv), await cliStatus("codex", root, parentEnv)];
  const installed = new Set(clis.filter((c) => c.path).map((c) => c.name as string));
  const roles = Object.entries(config.roles).filter((e): e is [string, Role] => e[1] !== undefined);
  const missing = roles
    .filter(([, r]) => r.runner !== "command" && !installed.has(r.runner))
    .map(([role, r]) => ({ role, runner: r.runner }));
  const report: DoctorReport = { clis, missing, node: process.version };
  if (!probe) return report;

  const pairs = new Map<string, [string, Role]>();
  for (const [name, r] of roles) {
    if (r.runner === "command") continue; // no read-only isolation for arbitrary CLIs: not probed
    const key = `${r.runner}/${r.model}`;
    if (!pairs.has(key)) pairs.set(key, [name, r]);
  }
  report.probes = [];
  for (const key of [...pairs.keys()].sort()) {
    const [roleName, role] = pairs.get(key)!;
    let result: RunResult | undefined;
    let detail: string | undefined;
    try {
      result = await runRole({
        root,
        roleName: `probe_${roleName}`,
        role,
        config,
        prompt: "Reply with exactly one word: OK",
        write: [],
        bash: [],
        expect: [],
        timeoutMs: 120_000,
        parentEnv,
      });
    } catch (e) {
      detail = (e as Error).message;
    }
    report.probes.push({
      runner: role.runner,
      model: role.model,
      ok: result?.ok ?? false,
      durationMs: result?.durationMs ?? 0,
      log: result?.log ?? "",
      ...(detail ? { detail } : result?.timedOut ? { detail: "timed out" } : result && !result.ok ? { detail: lastLogLine(result.log) ?? "failed" } : {}),
    });
  }
  return report;
}
