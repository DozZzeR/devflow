/** @file Exercise delegated plan approval and rejection using fake vendor responses. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseReview } from "../src/review.js";
import { fakeAgentBin } from "./fake.js";
import { gitProject, sh, write } from "./gitrepo.js";
import { tempDir } from "./helpers.js";

/** Path to the built CLI entry used by subprocess-based tests. */
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

/** Initialize the disposable project, fake executables and command helpers used by this suite. */
function setup(extra: Record<string, string> = {}) {
  const { root } = gitProject();
  const cfgPath = join(root, ".devflow", "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.openspec = { cli: "off" };
  cfg.runners = { env: { pass: ["FAKE_REVIEW", "FAKE_PROMPT_DIR", "FAKE_LIMIT_ROLE", "FAKE_LIMIT_OUTPUT"] } };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  sh(root, "git", ["add", "-A"]);
  sh(root, "git", ["commit", "-q", "-m", "config"]);
  const bin = fakeAgentBin(join(tempDir(), "bin"));
  const prompts = join(tempDir(), "prompts");
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, FAKE_PROMPT_DIR: prompts, ...extra };
  /** Execute the compiled CLI in the fixture and return captured output and exit status. */
  const devflow = (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: "utf8" });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  /** Load the task's persisted JSON so assertions can inspect transitions and counters. */
  const state = (id: string) => JSON.parse(readFileSync(join(root, ".devflow", "runs", id, "state.json"), "utf8"));
  /** Decode the CLI's newline-delimited stage reports for ordered assertions. */
  const lines = (out: string) => out.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  return { root, devflow, state, lines, prompts, env };
}

test("parseReview reads plain output and claude JSON results", () => {
  assert.deepEqual(parseReview("thinking...\nAPPROVE\n"), { verdict: "approve" });
  assert.deepEqual(parseReview("x\nREJECT: add a div-by-zero test\n"), { verdict: "reject", reason: "add a div-by-zero test" });
  assert.deepEqual(parseReview('{"type":"result","result":"Looks fine.\\nAPPROVE"}'), { verdict: "approve" });
  assert.equal(parseReview("no verdict here"), undefined);
});

test("Delegated review hits the limit and stays delegated", () => {
  const { devflow, state, lines } = setup({ FAKE_LIMIT_ROLE: "REVIEW", FAKE_LIMIT_OUTPUT: "codex" });
  assert.equal(devflow("start", "r1", "Add mul").code, 0);
  assert.equal(devflow("delegate-approval", "r1", "--to", "model").code, 0);
  assert.equal(devflow("run", "r1", "--once").code, 0);
  assert.equal(devflow("run", "r1", "--once").code, 0);
  const limited = devflow("run", "r1", "--once");
  assert.equal(limited.code, 75, limited.err);
  const [report, summary] = lines(limited.out);
  assert.equal(report.stage, "review");
  assert.equal(report.outcome, "paused");
  assert.equal(report.next.stage, "review");
  assert.equal(report.next.reason, "awaiting_plan_approval");
  assert.equal(summary.next.stage, "review");
  assert.equal(state("r1").status, "DESIGNED");
  assert.equal(state("r1").approval, "model");
  assert.equal(state("r1").pause.stage, "review");
});

test("Next run retries the review and clears the pause on approval", () => {
  const { devflow, env, state, lines } = setup({ FAKE_LIMIT_ROLE: "REVIEW", FAKE_LIMIT_OUTPUT: "codex", FAKE_REVIEW: "APPROVE" });
  assert.equal(devflow("start", "r1", "Add mul").code, 0);
  assert.equal(devflow("delegate-approval", "r1", "--to", "model").code, 0);
  assert.equal(devflow("run", "r1").code, 75);
  assert.equal(state("r1").status, "DESIGNED");
  assert.equal(state("r1").approval, "model");
  delete env.FAKE_LIMIT_ROLE;
  const retried = devflow("run", "r1", "--once");
  assert.equal(retried.code, 0, retried.err);
  const [review] = lines(retried.out);
  assert.equal(review.stage, "review");
  assert.equal(review.outcome, "approve");
  assert.equal(state("r1").status, "PLAN_APPROVED");
  assert.equal(state("r1").pause, undefined);
});

test("without delegation the run stops for the human", () => {
  const { devflow, lines } = setup({ FAKE_REVIEW: "APPROVE" });
  devflow("start", "r1", "Add mul");
  const r = lines(devflow("run", "r1").out);
  assert.equal(r.at(-1).next.reason, "awaiting_plan_approval");
});

test("delegated APPROVE continues to implement with a bound plan; reviewer saw only the plan", () => {
  const { devflow, state, lines, prompts } = setup({ FAKE_REVIEW: "APPROVE" });
  devflow("start", "r2", "Add mul");
  assert.equal(devflow("delegate-approval", "r2", "--to", "model").code, 0);
  const r = lines(devflow("run", "r2").out);
  const review = r.find((x) => x.stage === "review");
  assert.equal(review.outcome, "approve");
  assert.ok(state("r2").planDigest);
  assert.equal(state("r2").status, "DONE");
  const reviewPrompt = readdirSync(prompts).find((f) => f.startsWith("REVIEW"));
  assert.ok(reviewPrompt);
  assert.match(readFileSync(join(prompts, reviewPrompt!), "utf8"), /Plan revision: 1/);
});

test("delegated REJECT sends the plan back with the reason; three rejections hand approval back to the human", () => {
  const { devflow, state, lines } = setup({ FAKE_REVIEW: "REJECT: add negative numbers" });
  devflow("start", "r3", "Add mul");
  devflow("delegate-approval", "r3", "--to", "model");
  const r = lines(devflow("run", "r3").out);
  const rejects = r.filter((x) => x.stage === "review" && x.outcome === "reject");
  assert.ok(rejects.length >= 1);
  assert.equal(rejects[0].reason, "add negative numbers");
  const s = state("r3");
  assert.equal(s.approval, "human");
  assert.equal(s.status, "DESIGNED");
  assert.ok(s.history.some((h: { kind: string; reason?: string }) => h.kind === "review" && h.reason === "review_rejections_limit"));
});

test("unreadable review goes to the human; revocation restores human approval", () => {
  const { devflow, state, lines } = setup({ FAKE_REVIEW: "maybe?" });
  devflow("start", "r4", "Add mul");
  devflow("delegate-approval", "r4", "--to", "model");
  const r = lines(devflow("run", "r4").out);
  assert.equal(r.find((x) => x.stage === "review").reason, "unreadable_review");
  assert.equal(state("r4").approval, "human");
  devflow("delegate-approval", "r4", "--to", "model");
  devflow("delegate-approval", "r4", "--to", "human");
  assert.equal(state("r4").approval, "human");
});

test("approve and reject check the plan revision", () => {
  const { root, devflow } = setup();
  devflow("start", "r5", "Add mul");
  devflow("run", "r5");
  const moved = devflow("approve", "r5", "--revision", "2", "--json");
  assert.equal(JSON.parse(moved.err).error.reason, "plan_moved");
  assert.equal(devflow("approve", "r5", "--revision", "1", "--reject", "redo").code, 0);
  write(root, "x.txt", "");
});

test("the review prompt has no verdict-shaped lines that an echoed prompt could turn into a verdict", async () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "review.js"), "utf8");
  const promptStart = src.indexOf("You are the REVIEW role");
  const promptText = src.slice(promptStart, src.indexOf("`;", promptStart));
  assert.equal(parseReview(promptText), undefined);
});
