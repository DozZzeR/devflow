import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initProject, loadConfig } from "../src/config.js";
import { DevflowError } from "../src/errors.js";
import { proposeLayout, RANKING, setRole, type Candidate } from "../src/roles.js";
import { tempDir } from "./helpers.js";

const by = (runner: "claude" | "codex") => RANKING.filter((c) => c.runner === runner);
const k = (c: Candidate) => `${c.runner}/${c.model}`;

test("both vendors: strongest on design_complex/review, no Fable for design, verify on the other vendor", () => {
  const p = proposeLayout(RANKING);
  assert.equal(k(p.roles.design_complex), "claude/fable");
  assert.equal(k(p.roles.review), "claude/fable");
  assert.equal(k(p.roles.design), "claude/opus");
  assert.notEqual(k(p.roles.verify), k(p.roles.implement));
  assert.notEqual(p.roles.verify.runner, p.roles.implement.runner);
  assert.equal(k(p.roles.explore), "codex/gpt-5.6-luna");
  assert.deepEqual(p.warnings, []);
});

test("Fable unavailable: opus takes its place", () => {
  const p = proposeLayout(RANKING.filter((c) => c.model !== "fable"));
  assert.equal(k(p.roles.design_complex), "claude/opus");
  assert.equal(k(p.roles.review), "claude/opus");
});

test("one vendor only: verify still differs from implement", () => {
  const p = proposeLayout(by("codex"));
  assert.ok(Object.values(p.roles).every((r) => r.runner === "codex"));
  assert.notEqual(k(p.roles.verify), k(p.roles.implement));
});

test("one candidate warns, none fails", () => {
  const p = proposeLayout([{ runner: "codex", model: "gpt-6.2-sol" }]);
  assert.deepEqual(p.warnings, ["verify_not_independent"]);
  assert.throws(() => proposeLayout([]), (e: unknown) => e instanceof DevflowError && e.reason === "no_models");
});

test("set validates and writes atomically; an invalid set leaves the file unchanged", () => {
  const root = tempDir();
  initProject(root, { detected: { claude: true, codex: true } });
  assert.equal(loadConfig(root).roles.design_complex?.model, "opus"); // presets: no Fable
  setRole(root, "verify", "claude", "opus");
  assert.equal(loadConfig(root).roles.verify.model, "opus");
  const before = readFileSync(join(root, ".devflow", "config.json"), "utf8");
  assert.throws(() => setRole(root, "verify", "gemini", "x"), (e: unknown) => e instanceof DevflowError && e.reason === "invalid_config");
  assert.throws(() => setRole(root, "explore", "command", "m"), (e: unknown) => e instanceof DevflowError);
  assert.equal(readFileSync(join(root, ".devflow", "config.json"), "utf8"), before);
  setRole(root, "explore", "command", "m", "opencode run --model {model}");
  assert.equal(loadConfig(root).roles.explore.runner, "command");
});
