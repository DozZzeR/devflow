import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCommand } from "../src/proc.js";
import { tempDir } from "./helpers.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUILD = join(REPO, "scripts", "build-plugins.mjs");

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p).replace(/\\/g, "/"));
    }
  };
  walk(dir);
  return out.sort();
}

// Built once at file level: a temp dir created inside a test is removed when that test ends.
const BUILT = join(tempDir(), "plugins");
const buildResult = spawnSync(process.execPath, [BUILD, BUILT], { cwd: REPO, encoding: "utf8" });
const fresh = () => {
  assert.equal(buildResult.status, 0, buildResult.stderr);
  return BUILT;
};

test("committed plugins equal a fresh build", () => {
  const built = fresh();
  const committed = join(REPO, "plugins");
  assert.deepEqual(files(committed), files(built));
  for (const f of files(built)) {
    assert.ok(readFileSync(join(committed, f)).equals(readFileSync(join(built, f))), `stale: plugins/${f} — run npm run build:plugins`);
  }
});

test("skills are byte-identical to the source in both plugins", () => {
  const built = fresh();
  for (const skill of readdirSync(join(REPO, "skills"))) {
    const src = readFileSync(join(REPO, "skills", skill, "SKILL.md"));
    for (const client of ["claude", "codex"]) {
      assert.ok(src.equals(readFileSync(join(built, client, "devflow", "skills", skill, "SKILL.md"))), `${client}/${skill}`);
    }
  }
});

test("bundle runs without install and manifests launch it as an MCP server", () => {
  const built = fresh();
  const bundle = join(built, "claude", "devflow", "bin", "devflow.mjs");
  const r = spawnSync(process.execPath, [bundle, "--version"], { cwd: tempDir(), encoding: "utf8" });
  assert.equal(r.stdout.trim(), JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version);
  const claudeMcp = JSON.parse(readFileSync(join(built, "claude", "devflow", ".mcp.json"), "utf8"));
  assert.deepEqual(claudeMcp.mcpServers.devflow.args, ["${CLAUDE_PLUGIN_ROOT}/bin/devflow.mjs", "mcp"]);
  const codexMcp = JSON.parse(readFileSync(join(built, "codex", "devflow", ".mcp.json"), "utf8"));
  assert.deepEqual(codexMcp.mcpServers.devflow.args, ["./bin/devflow.mjs", "mcp"]);
  const codexManifest = JSON.parse(readFileSync(join(built, "codex", "devflow", ".codex-plugin", "plugin.json"), "utf8"));
  assert.deepEqual([codexManifest.skills, codexManifest.mcpServers], ["./skills/", "./.mcp.json"]);
  assert.ok(statSync(bundle).size > 0);
});

test("claude plugin validate passes (when claude is installed)", (t) => {
  const claude = resolveCommand("claude");
  if (!claude) {
    t.skip("claude CLI not installed");
    return;
  }
  const r = spawnSync(claude, ["plugin", "validate", join(REPO, "plugins", "claude", "devflow")], { encoding: "utf8", input: "" });
  assert.match(r.stdout + r.stderr, /Validation passed/);
  assert.ok(existsSync(join(REPO, ".claude-plugin", "marketplace.json")));
  assert.ok(existsSync(join(REPO, ".agents", "plugins", "marketplace.json")));
});
