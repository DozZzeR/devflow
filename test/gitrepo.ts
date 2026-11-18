import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { initProject } from "../src/config.js";
import { tempDir } from "./helpers.js";

export function sh(cwd: string, cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

export function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/**
 * A git repo with a devflow project and a tiny test runner:
 * `node check.js` runs every file in tests/ and exits 1 if any throws.
 */
export function gitProject(opts: { subdir?: string } = {}): { repo: string; root: string; base: string } {
  const repo = tempDir();
  const root = opts.subdir ? join(repo, opts.subdir) : repo;
  mkdirSync(root, { recursive: true });
  sh(repo, "git", ["init", "-q", "-b", "main"]);
  sh(repo, "git", ["config", "user.email", "t@example.com"]);
  sh(repo, "git", ["config", "user.name", "t"]);
  sh(repo, "git", ["config", "core.autocrlf", "false"]);
  initProject(root, { detected: { claude: false, codex: true } });
  const cfgPath = join(root, ".devflow", "config.json");
  const cfg = JSON.parse(require_("fs").readFileSync(cfgPath, "utf8"));
  cfg.test = { command: "node check.js", paths: ["tests/**"], timeout_seconds: 60 };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  write(root, "check.js", [
    "const fs = require('fs'); const path = require('path');",
    "let failed = 0;",
    "const dir = path.join(__dirname, 'tests');",
    "for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {",
    "  try { require(path.join(dir, f)); } catch (e) { failed++; console.error(f, e.message); }",
    "}",
    "process.exit(failed ? 1 : 0);",
  ].join("\n"));
  write(root, "src/math.js", "exports.add = (a, b) => a + b;\n");
  write(root, "tests/add.test.js", "const { add } = require('../src/math'); if (add(1, 2) !== 3) throw new Error('add');\n");
  write(root, ".gitignore", "ignored/\n");
  sh(repo, "git", ["add", "-A"]);
  sh(repo, "git", ["commit", "-q", "-m", "base"]);
  const base = sh(repo, "git", ["rev-parse", "HEAD"]).trim();
  return { repo, root, base };
}

import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
