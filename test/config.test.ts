import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, findProjectRoot, initProject, loadConfig, parseConfig } from "../src/config.js";
import { DevflowError } from "../src/errors.js";
import { tempDir } from "./helpers.js";

const base = () => structuredClone(DEFAULT_CONFIG) as Record<string, any>;

function problems(raw: unknown): string[] {
  try {
    parseConfig(raw);
  } catch (e) {
    assert.ok(e instanceof DevflowError);
    assert.equal(e.reason, "invalid_config");
    return e.details as string[];
  }
  assert.fail("expected invalid_config");
}

test("valid configuration loads", () => {
  const c = parseConfig(base());
  assert.equal(c.roles.verify.runner, "codex");
});

test("language defaults to en and accepts an explicit tag", () => {
  const raw = base();
  delete raw.language;
  assert.equal(parseConfig(raw).language, "en");
  assert.equal(parseConfig({ ...base(), language: "ru" }).language, "ru");
  assert.ok(problems({ ...base(), language: "russian!" }).some((p) => p.startsWith("language:")));
});

test("unknown field is reported by name", () => {
  assert.ok(problems({ ...base(), limitz: {} }).includes("limitz: unknown field"));
  const nested = base();
  nested.roles.explore.temperature = 0;
  assert.ok(problems(nested).includes("roles.explore.temperature: unknown field"));
});

test("command runner without template names roles.<role>.command", () => {
  const raw = base();
  raw.roles.implement = { runner: "command", model: "local" };
  assert.ok(problems(raw).some((p) => p.startsWith("roles.implement.command:")));
});

test("missing verify role names roles.verify", () => {
  const raw = base();
  delete raw.roles.verify;
  assert.ok(problems(raw).some((p) => p.startsWith("roles.verify:")));
});

test("wrong types are reported, not defaulted", () => {
  const raw = base();
  raw.limits.implement = 0;
  assert.ok(problems(raw).some((p) => p.startsWith("limits.implement:")));
});

test("init creates config and .gitignore and nothing else", () => {
  const dir = tempDir();
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  const r = initProject(dir);
  assert.deepEqual([r.configCreated, r.gitignore], [true, "created"]);
  assert.deepEqual(readdirSync(join(dir, ".devflow")).sort(), [".gitignore", "config.json"]);
  assert.equal(readFileSync(join(dir, ".devflow", ".gitignore"), "utf8"), "runs/\nlogs/\njobs/\n");
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "node_modules/\n");
  assert.equal(loadConfig(dir).language, "en");
});

test("init upgrades an old .devflow/.gitignore without touching existing lines", () => {
  const dir = tempDir();
  mkdirSync(join(dir, ".devflow"));
  writeFileSync(join(dir, ".devflow", ".gitignore"), "runs/\ncustom");
  const r = initProject(dir);
  assert.equal(r.gitignore, "updated");
  assert.equal(readFileSync(join(dir, ".devflow", ".gitignore"), "utf8"), "runs/\ncustom\nlogs/\njobs/\n");
});

test("init picks runners from detected CLIs or an override", () => {
  const roles = (d: string) => loadConfig(d).roles;
  const codexOnly = tempDir();
  initProject(codexOnly, { detected: { claude: false, codex: true } });
  const c = roles(codexOnly);
  assert.ok(Object.values(c).every((r) => r?.runner === "codex"));
  assert.notEqual(c.verify.model, c.implement.model);

  const claudeOnly = tempDir();
  initProject(claudeOnly, { detected: { claude: true, codex: false } });
  const k = roles(claudeOnly);
  assert.ok(Object.values(k).every((r) => r?.runner === "claude"));
  assert.notEqual(k.verify.model, k.implement.model);

  const none = tempDir();
  const r = initProject(none, { detected: { claude: false, codex: false } });
  assert.equal(r.runners, "mixed");
  assert.match(r.warnings.join(" "), /No supported CLI/);

  const forced = tempDir();
  initProject(forced, { runners: "claude", detected: { claude: true, codex: true } });
  assert.ok(Object.values(roles(forced)).every((r) => r?.runner === "claude"));
});

test("runners section: accepted with defaults, unknown keys rejected", () => {
  const c = parseConfig({ ...base(), runners: { codex: { ignore_user_config: true } } });
  assert.deepEqual([c.runners.codex.ignore_user_config, c.runners.codex.use_api_key, c.runners.claude.use_api_key], [true, false, false]);
  assert.equal(parseConfig(base()).runners.codex.ignore_user_config, false);
  assert.deepEqual(parseConfig(base()).runners.env.pass, []);
  assert.ok(problems({ ...base(), runners: { codex: { turbo: true } } }).includes("runners.codex.turbo: unknown field"));
});

test("init refuses a linked .devflow directory", (t) => {
  const dir = tempDir();
  const target = tempDir();
  try {
    symlinkSync(target, join(dir, ".devflow"), "junction");
  } catch {
    t.skip("cannot create links here");
    return;
  }
  assert.throws(() => initProject(dir), (e: unknown) => e instanceof DevflowError && e.reason === "unsafe_path");
});

test("init is idempotent and leaves an existing config unchanged", () => {
  const dir = tempDir();
  mkdirSync(join(dir, ".devflow"));
  writeFileSync(join(dir, ".devflow", "config.json"), "{ \"custom\": true }\n");
  const r = initProject(dir);
  assert.equal(r.configCreated, false);
  assert.equal(readFileSync(join(dir, ".devflow", "config.json"), "utf8"), "{ \"custom\": true }\n");
});

test("project root is found from a subdirectory; absent root is an error", () => {
  const dir = tempDir();
  initProject(dir);
  const sub = join(dir, "a", "b");
  mkdirSync(sub, { recursive: true });
  assert.equal(findProjectRoot(sub), dir);
  const bare = tempDir();
  assert.ok(!existsSync(join(bare, ".devflow")));
  assert.throws(() => findProjectRoot(bare), (e: unknown) => e instanceof DevflowError && e.reason === "no_project");
});

test("init refuses a linked .gitignore before creating the config", (t) => {
  const dir = tempDir();
  mkdirSync(join(dir, ".devflow"));
  const target = join(tempDir(), "elsewhere.txt");
  writeFileSync(target, "x");
  try {
    symlinkSync(target, join(dir, ".devflow", ".gitignore"), "file");
  } catch {
    t.skip("cannot create file links here");
    return;
  }
  assert.throws(() => initProject(dir), (e: unknown) => e instanceof DevflowError && e.reason === "unsafe_path");
  assert.ok(!existsSync(join(dir, ".devflow", "config.json")));
  assert.equal(readFileSync(target, "utf8"), "x");
});
