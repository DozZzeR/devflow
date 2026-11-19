/** @file Check changed paths and temporary worktree handling, including nested project roots. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { changeSet, headCommit, repoInfo } from "../src/git.js";
import { gitProject, sh, write } from "./gitrepo.js";
import { tempDir } from "./helpers.js";

test("change set: modified, added, deleted, renamed, untracked; ignored and devflow runtime excluded", () => {
  const { repo, root, base } = gitProject();
  write(root, "src/math.js", "exports.add = (a, b) => a + b + 0;\n");
  write(root, "src/new file.js", "x\n");
  rmSync(join(root, "tests", "add.test.js"));
  sh(repo, "git", ["mv", "check.js", "runner.js"]);
  write(root, "ignored/x.txt", "x");
  write(root, ".devflow/runs/t1/state.json", "{}");
  write(root, ".devflow/config.json", "{}\n");
  assert.deepEqual(changeSet(root, base), [
    ".devflow/config.json",
    "check.js",
    "runner.js",
    "src/math.js",
    "src/new file.js",
    "tests/add.test.js",
  ]);
});

test("project in a subdirectory: paths are project-relative and limited to the project", () => {
  const { repo, root, base } = gitProject({ subdir: "app" });
  write(repo, "outside.txt", "x");
  write(root, "src/math.js", "changed\n");
  assert.equal(repoInfo(root)?.prefix, "app/");
  assert.deepEqual(changeSet(root, base), ["src/math.js"]);
});

test("no git: repoInfo undefined, headCommit absent", () => {
  const dir = tempDir();
  assert.equal(repoInfo(dir), undefined);
  const { root, base } = gitProject();
  assert.equal(headCommit(root), base);
});
