/** @file Validate the contents and permitted scope of an OpenSpec change before plan approval. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { DevflowError } from "./errors.js";
import { buildChildEnv, launch, resolveCommand } from "./proc.js";
import { changeFileHashes, changeFiles, changeFolder } from "./snapshot.js";
import { parseImpactZone } from "./zone.js";
import { loadTask, taskDir } from "./store.js";
import { decidedFeedback, reviewDecisions } from "./plan-nodes.js";
import { section } from "./prompts.js";

/** Root Markdown artifacts expected in every planned change. */
export const REQUIRED_PLAN_FILES = ["proposal.md", "design.md", "tasks.md"];

/** Outcome of validating a plan folder and extracting its implementation scope. */
export interface DesignCheck {
  /** Whether every enabled plan check passed. */
  ok: boolean;
  /** Machine-readable first failure reported to design or approval. */
  reason?: string;
  /** Diagnostic context for the failed check, such as missing paths. */
  details?: unknown;
  /** Project-relative write globs extracted from a valid design. */
  zone?: string[];
}

/** Resolve the OpenSpec CLI per `openspec.cli`: PATH first, then the project's node_modules/.bin. */
export function openspecCommand(root: string, config: Config): string | undefined {
  const mode = config.openspec?.cli ?? "auto";
  if (mode === "off") return undefined;
  const env = buildChildEnv(process.env);
  const onPath = resolveCommand("openspec", env);
  if (onPath) return onPath;
  for (const name of process.platform === "win32" ? ["openspec.cmd", "openspec.exe"] : ["openspec"]) {
    const local = join(root, "node_modules", ".bin", name);
    if (existsSync(local)) return local;
  }
  return undefined;
}

/** Run strict OpenSpec validation in the project and retain output for failed checks. */
async function validateWithCli(root: string, id: string, command: string): Promise<{ ok: boolean; output: string }> {
  let output = "";
  const r = await launch({
    command,
    args: ["validate", id, "--strict", "--no-color"],
    cwd: root,
    env: buildChildEnv(process.env),
    stdin: "",
    timeoutMs: 120_000,
    onOutput: (c) => (output += c),
  });
  return { ok: r.exitCode === 0 && !r.timedOut, output: output.trim() };
}

/**
 * Checks after a design run (and again at approval): required files, fresh spec deltas (when `before` is given),
 * a parsable impact zone, and OpenSpec validation according to `openspec.cli`.
 * @param before - Optional pre-run hashes used to detect stale design artifacts.
 */
export async function checkDesign(root: string, id: string, config: Config, before?: Map<string, string>): Promise<DesignCheck> {
  const dir = changeFolder(root, id);
  const missing = REQUIRED_PLAN_FILES.filter((f) => !existsSync(join(dir, f)));
  if (missing.length) return { ok: false, reason: "missing_plan_files", details: { missing } };

  try {
    const rounds = reviewDecisions(readFileSync(join(dir, "tasks.md"), "utf8"));
    if (rounds.size) {
      const reviews = loadTask(root, id).history.filter(h => h.kind === "complete" && h.stage === "verify");
      for (const [round, rows] of rounds) {
        if (reviews[round - 1]?.outcome !== "rework") throw new Error("No REWORK at review round " + round);
        const name = round === reviews.length ? "verdict.md" : "verdict-round" + round + ".md";
        decidedFeedback(rows, readFileSync(join(taskDir(root, id), name), "utf8"));
      }
    }
  } catch (e) {
    const reason = e instanceof DevflowError && e.reason === "invalid_verdict_findings" ? e.reason : "invalid_plan_nodes";
    return { ok: false, reason, details: { message: (e as Error).message } };
  }

  if (before) {
    const after = changeFileHashes(root, id);
    const stale = changeFiles(root, id).filter((f) => f.startsWith("specs/") && before.get(f) === after.get(f));
    if (stale.length) return { ok: false, reason: "stale_delta", details: { stale } };
  }

  const design = readFileSync(join(dir, "design.md"), "utf8");
  let zone: string[];
  try {
    zone = parseImpactZone(design);
  } catch (e) {
    return { ok: false, reason: e instanceof DevflowError ? e.reason : "invalid_zone", details: { message: (e as Error).message } };
  }
  if (!section(design, "Test plan")) return { ok: false, reason: "missing_test_plan" };

  const deltas = changeFiles(root, id).filter((f) => /^specs\/.+\/spec\.md$/.test(f));
  const usable = deltas.filter((f) => {
    const text = readFileSync(join(dir, f), "utf8");
    return /^###\s+Requirement:/m.test(text) && /^####\s+Scenario:/m.test(text);
  });
  if (!usable.length) return { ok: false, reason: "missing_spec_delta", details: { deltas } };

  const mode = config.openspec?.cli ?? "auto";
  const cli = openspecCommand(root, config);
  if (mode === "on" && !cli) return { ok: false, reason: "openspec_missing" };
  if (cli) {
    const v = await validateWithCli(root, id, cli);
    if (!v.ok) return { ok: false, reason: "openspec_invalid", details: { output: v.output.slice(-4000) } };
  }
  return { ok: true, zone };
}
