import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { parseConfig, DEFAULT_CONFIG, type Config } from "../src/config.js";
import { newTask, transition, type Event, type TaskState, type Tier } from "../src/lifecycle.js";

export const NOW = "2026-11-17T12:00:00.000Z";

export function config(overrides: { limits?: Partial<Config["limits"]> } = {}): Config {
  return parseConfig({
    ...structuredClone(DEFAULT_CONFIG),
    limits: { ...DEFAULT_CONFIG.limits, ...overrides.limits },
  });
}

export function task(tier: Tier = "medium"): TaskState {
  return newTask("t1", "test task", tier, undefined, NOW);
}

/** Apply events in order. */
export function play(t: TaskState, cfg: Config, ...events: Event[]): TaskState {
  return events.reduce((s, e) => transition(s, e, cfg, NOW), t);
}

export const ok = (stage: "explore" | "design" | "implement" | "gates"): Event =>
  stage === "gates" ? { kind: "gates", outcome: "pass" } : { kind: "complete", stage, outcome: "ok" };
export const fail = (stage: "explore" | "design" | "implement" | "gates"): Event =>
  stage === "gates" ? { kind: "gates", outcome: "fail", gate: "tests" } : { kind: "complete", stage, outcome: "fail" };
export const verify = (outcome: "pass" | "rework" | "human"): Event =>
  outcome === "pass" ? { kind: "complete", stage: "verify", outcome, override: "test helper" } : { kind: "complete", stage: "verify", outcome };

/** A temp dir removed after the test file finishes. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "devflow-test-"));
  after(() => {
    // On Windows a just-killed background process can hold the folder for a moment: retry, then leave it
    // to the OS temp cleanup instead of failing a test over a leftover temp folder.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EPERM" && (e as NodeJS.ErrnoException).code !== "EBUSY") throw e;
    }
  });
  return dir;
}
