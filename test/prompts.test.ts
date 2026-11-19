/** @file Check stage templates, overrides and verifier-specific inputs across review rounds. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { composePrompt, loadTemplate, section, TEMPLATES } from "../src/prompts.js";
import { checkDesign } from "../src/artifacts.js";
import { normaliseTasks, planDigest, snapshotDigest } from "../src/snapshot.js";
import { initProject, loadConfig } from "../src/config.js";
import { DevflowError } from "../src/errors.js";
import { gitProject, write } from "./gitrepo.js";
import { tempDir } from "./helpers.js";

/** Build the common prompt inputs used by the stage cases. */
const base = { id: "t1", description: "Add mul", language: "ru", outputs: "x.md", context: "CTX", testCommand: "npm test" };

test("templates carry task, language, outputs and context", () => {
  for (const stage of ["explore", "design", "implement", "small", "verify"] as const) {
    const p = composePrompt(TEMPLATES[stage], base);
    assert.match(p, /Task id: t1/);
    assert.match(p, /language: ru/);
    assert.match(p, /Outputs: x\.md/);
    assert.match(p, /CTX/);
    assert.doesNotMatch(p, /\{\{/);
  }
});

test("verify round 2 adds the previous verdict and the narrowing rule; round 1 does not", () => {
  const r1 = composePrompt(TEMPLATES.verify, { ...base, round: 1, previousVerdict: "OLD" });
  assert.doesNotMatch(r1, /OLD|ONLY high-severity/);
  const r2 = composePrompt(TEMPLATES.verify, { ...base, round: 2, previousVerdict: "OLD VERDICT" });
  assert.match(r2, /OLD VERDICT/);
  assert.match(r2, /ONLY high-severity findings and regressions/);
  assert.match(r1, /REWORK only for at least one high or medium finding/);
  assert.match(r1, /intentionally absent/);
});

test("verify prompt defines the severity rubric in every round", () => {
  const defs = [
    "high = an acceptance criterion is not met",
    "medium = a likely defect with a workaround",
    "low = style, tests or hardening outside the threat model",
    "REWORK only for at least one high or medium finding",
  ];
  const r1 = composePrompt(TEMPLATES.verify, { ...base, round: 1 });
  const r2 = composePrompt(TEMPLATES.verify, { ...base, round: 2, previousVerdict: "OLD" });
  for (const d of defs) {
    assert.ok(r1.includes(d), `round 1 lacks: ${d}`);
    assert.ok(r2.includes(d), `round 2 lacks: ${d}`);
  }
  assert.equal(r2.split("ONLY high-severity findings and regressions").length - 1, 1);
});

test("project override replaces a template; unknown placeholders are rejected", () => {
  const root = tempDir();
  initProject(root);
  mkdirSync(join(root, ".devflow", "prompts"));
  writeFileSync(join(root, ".devflow", "prompts", "verify.md"), "Custom {{id}}");
  assert.equal(composePrompt(loadTemplate(root, "verify"), base), "Custom t1");
  assert.throws(() => composePrompt("{{secret}}", base), (e: unknown) => e instanceof DevflowError && e.reason === "invalid_template");
});

test("section extracts one heading's body", () => {
  const md = "# D\n## Decisions\nhidden\n## Test plan\n- a\n- b\n## Risks\nr\n";
  assert.equal(section(md, "Test plan"), "- a\n- b");
  assert.equal(section(md, "Nope"), "");
});

test("plan digest ignores checkbox ticks but not text", () => {
  const root = tempDir();
  write(root, "openspec/changes/t1/tasks.md", "- [ ] 1.1 Do it\n");
  write(root, "openspec/changes/t1/design.md", "x");
  const d1 = planDigest(root, "t1");
  write(root, "openspec/changes/t1/tasks.md", "- [x] 1.1 Do it\n");
  assert.equal(planDigest(root, "t1"), d1);
  write(root, "openspec/changes/t1/tasks.md", "- [x] 1.1 Do something else\n");
  assert.notEqual(planDigest(root, "t1"), d1);
  assert.equal(normaliseTasks("* [X] a"), "* [ ] a");
});

test("snapshot digest follows content, deletion, new files and config", () => {
  const { root, base: b } = gitProject();
  const cfg = loadConfig(root);
  const s0 = snapshotDigest(root, b, cfg);
  write(root, "src/new.js", "x");
  const s1 = snapshotDigest(root, b, cfg);
  assert.notEqual(s1, s0);
  assert.equal(snapshotDigest(root, b, cfg), s1);
  write(root, "src/new.js", "y");
  assert.notEqual(snapshotDigest(root, b, cfg), s1);
  const other = { ...cfg, test: { ...cfg.test, command: "other" } };
  assert.notEqual(snapshotDigest(root, b, other), snapshotDigest(root, b, cfg));
});

/** Write a minimal OpenSpec change used as prompt context. */
function plan(root: string) {
  write(root, "openspec/changes/t1/proposal.md", "# P\n");
  write(root, "openspec/changes/t1/tasks.md", "- [ ] 1.1 x\n");
  write(root, "openspec/changes/t1/design.md", "## Impact zone\n- src/**\n\n## Test plan\n- t\n");
  write(root, "openspec/changes/t1/specs/a/spec.md", "## ADDED Requirements\n\n### Requirement: X\n\nThe system SHALL x.\n\n#### Scenario: Y\n\n- **WHEN** a\n- **THEN** b\n");
}

test("design checks: files, zone, test plan, stale deltas, validation modes", async () => {
  const root = tempDir();
  initProject(root);
  const cfg = loadConfig(root);
  cfg.openspec = { cli: "off" };
  assert.equal((await checkDesign(root, "t1", cfg)).reason, "missing_plan_files");
  plan(root);
  const ok = await checkDesign(root, "t1", cfg);
  assert.deepEqual([ok.ok, ok.zone], [true, ["src/**"]]);

  const before = new Map([["specs/a/spec.md", "irrelevant"]]);
  const { changeFileHashes } = await import("../src/snapshot.js");
  const same = changeFileHashes(root, "t1");
  assert.equal((await checkDesign(root, "t1", cfg, same)).reason, "stale_delta");
  assert.equal((await checkDesign(root, "t1", cfg, before)).ok, true);

  write(root, "openspec/changes/t1/design.md", "## Impact zone\n- src/**\n");
  assert.equal((await checkDesign(root, "t1", cfg)).reason, "missing_test_plan");
  plan(root);

  cfg.openspec = { cli: "on" };
  const prevPath = process.env.PATH;
  process.env.PATH = join(root, "nothing-here");
  try {
    assert.equal((await checkDesign(root, "t1", cfg)).reason, "openspec_missing");
  } finally {
    process.env.PATH = prevPath;
  }
});

test("design checks run a project-local openspec and report its failure", async () => {
  const root = tempDir();
  initProject(root);
  plan(root);
  const cfg = loadConfig(root);
  cfg.openspec = { cli: "auto" };
  const bin = join(root, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const script = join(root, "fake-openspec.cjs");
  writeFileSync(script, "console.log('invalid change'); process.exit(process.env.X_OK ? 0 : 1);\n");
  if (process.platform === "win32") writeFileSync(join(bin, "openspec.cmd"), `@"${process.execPath}" "${script}" %*\r\n`);
  else {
    writeFileSync(join(bin, "openspec"), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    chmodSync(join(bin, "openspec"), 0o755);
  }
  const prevPath = process.env.PATH;
  process.env.PATH = join(root, "nothing-here");
  try {
    const r = await checkDesign(root, "t1", cfg);
    assert.equal(r.reason, "openspec_invalid");
    assert.match(JSON.stringify(r.details), /invalid change/);
  } finally {
    process.env.PATH = prevPath;
  }
});
