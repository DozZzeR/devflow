import { readFileSync } from "node:fs";
import type { Config, Role } from "./config.js";
import { buildChildEnv, launch, resolveCommand } from "./proc.js";
import { runRole, type RunResult } from "./runners.js";

export interface CliStatus {
  name: "claude" | "codex";
  path: string | null;
  version: string | null;
  login: string;
}

export interface DoctorReport {
  clis: CliStatus[];
  missing: { role: string; runner: string }[];
  probes?: { runner: string; model: string; ok: boolean; durationMs: number; log: string; detail?: string }[];
}

async function capture(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number | null; out: string }> {
  let out = "";
  try {
    const r = await launch({ command, args, cwd, env, stdin: "", timeoutMs: 30_000, onOutput: (c) => (out += c) });
    return { code: r.timedOut ? null : r.exitCode, out: out.trim() };
  } catch (e) {
    return { code: null, out: (e as Error).message };
  }
}

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

function lastLogLine(path: string): string | undefined {
  try {
    const lines = readFileSync(path, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return lines.at(-1)?.slice(0, 200);
  } catch {
    return undefined;
  }
}

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

export async function doctor(root: string, config: Config, probe: boolean, parentEnv: NodeJS.ProcessEnv = process.env): Promise<DoctorReport> {
  const clis = [await cliStatus("claude", root, parentEnv), await cliStatus("codex", root, parentEnv)];
  const installed = new Set(clis.filter((c) => c.path).map((c) => c.name as string));
  const roles = Object.entries(config.roles).filter((e): e is [string, Role] => e[1] !== undefined);
  const missing = roles
    .filter(([, r]) => r.runner !== "command" && !installed.has(r.runner))
    .map(([role, r]) => ({ role, runner: r.runner }));
  const report: DoctorReport = { clis, missing };
  if (!probe) return report;

  const pairs = new Map<string, [string, Role]>();
  for (const [name, r] of roles) {
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
