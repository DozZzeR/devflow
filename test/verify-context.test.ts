import { test } from "node:test";
import assert from "node:assert/strict";
import { parseContextKey, verificationContext } from "../src/verify-context.js";
import { changeSet } from "../src/git.js";
import { gitProject, sh, write } from "./gitrepo.js";

test("parseContextKey reads block scalars", () => {
  assert.equal(parseContextKey("name: x\ncontext: |\n  line one\n  line two\n\nother: 1\n"), "line one\nline two");
  assert.equal(parseContextKey("context: |-\n    a\n      b\nnext: 2\n"), "a\n  b");
  assert.equal(parseContextKey("context: >\n  folded text\n  more\n"), "folded text more");
});

test("parseContextKey preserves paragraphs and more-indented lines in folded scalars", () => {
  assert.equal(parseContextKey("context: >\n  a\n  b\n\n  c\n  d\n"), "a b\nc d");
  assert.equal(parseContextKey("context: >\n  a\n  b\n\n\n  c\n  d\n"), "a b\n\nc d");
  assert.equal(parseContextKey("context: >\n  a\n    code\n  b\n"), "a\n  code\nb");
  assert.equal(parseContextKey("context: >\n  a\n\n    code\n\n  b\n"), "a\n\n  code\n\nb");
});

test("parseContextKey ignores block header comments and rejects explicit indentation", () => {
  assert.equal(parseContextKey("context: | # note\n  x\n  y\n"), "x\ny");
  assert.equal(parseContextKey("context: >- # note\n  x\n  y\n"), "x y");
  assert.equal(parseContextKey("context: |2 # note\n  x\n"), "");
  assert.equal(parseContextKey("context: >-2\n  x\n"), "");
});

test("parseContextKey reads inline values and removes one pair of quotes", () => {
  assert.equal(parseContextKey("context: plain text\n"), "plain text");
  assert.equal(parseContextKey("context: \"quoted text\"\n"), "quoted text");
  assert.equal(parseContextKey("context: 'single'\n"), "single");
  assert.equal(parseContextKey("context: plain#text # note\n"), "plain#text");
  assert.equal(parseContextKey("context: \"quoted # text\" # note\n"), "quoted # text");
});

test("parseContextKey returns empty for commented, empty or missing keys", () => {
  assert.equal(parseContextKey("# context: |\n#   text\nschema: x\n"), "");
  assert.equal(parseContextKey("context:\nother: 1\n"), "");
  assert.equal(parseContextKey("context: # note\n"), "");
  assert.equal(parseContextKey("context: |\nother: 1\n"), "");
  assert.equal(parseContextKey("schema: spec-driven\n"), "");
  assert.equal(parseContextKey("  context: indented\n"), "");
});

function commit(repo: string, msg: string): string {
  sh(repo, "git", ["add", "-A"]);
  sh(repo, "git", ["commit", "-q", "-m", msg]);
  return sh(repo, "git", ["rev-parse", "HEAD"]).trim();
}

test("YAML context wins over .devflow/context.md", () => {
  const { repo, root } = gitProject();
  write(root, "openspec/config.yaml", "schema: spec-driven\ncontext: |\n  YAML-SCOPE\n  second\n");
  write(root, ".devflow/context.md", "FILE-SCOPE\n");
  const base = commit(repo, "ctx");
  assert.equal(verificationContext(root, base, changeSet(root, base)), "YAML-SCOPE\nsecond");
});

test("reads folded YAML context with a header comment", () => {
  const { repo, root } = gitProject();
  write(root, "openspec/config.yaml", "context: > # note\n  a\n  b\n\n  c\n");
  const base = commit(repo, "ctx");
  assert.equal(verificationContext(root, base, []), "a b\nc");
});

test("a less-indented YAML comment ends the block without triggering fallback", () => {
  const { repo, root } = gitProject();
  write(root, "openspec/config.yaml", "context: > # note\n  a\n  b\n\n  c\n # config comment\nschema: spec-driven\n");
  write(root, ".devflow/context.md", "FILE-SCOPE\n");
  const base = commit(repo, "ctx");
  assert.equal(verificationContext(root, base, []), "a b\nc");
  assert.equal(parseContextKey("context: |\n  a\n  # scalar text\n # config comment\n"), "a\n# scalar text");
});

test("falls back to .devflow/context.md when the YAML has no context", () => {
  const { repo, root } = gitProject();
  write(root, "openspec/config.yaml", "schema: spec-driven\n# context: |\n#   commented\n");
  write(root, ".devflow/context.md", "FILE-SCOPE\n");
  const base = commit(repo, "ctx");
  assert.equal(verificationContext(root, base, []), "FILE-SCOPE");
});

test("no source returns an empty string", () => {
  const { root, base } = gitProject();
  assert.equal(verificationContext(root, base, []), "");
});

test("a changed source is read from the base", () => {
  const { repo, root } = gitProject();
  write(root, ".devflow/context.md", "BASE-SCOPE\n");
  const base = commit(repo, "ctx");
  write(root, ".devflow/context.md", "CHANGED-SCOPE\n");
  const changes = changeSet(root, base);
  assert.ok(changes.includes(".devflow/context.md"));
  assert.equal(verificationContext(root, base, changes), "BASE-SCOPE");
});

test("a new source in the change set counts as absent", () => {
  const { root, base } = gitProject();
  write(root, ".devflow/context.md", "NEW-SCOPE\n");
  assert.equal(verificationContext(root, base, [".devflow/context.md"]), "");
});

test("works inside a repository subdirectory", () => {
  const { repo, root } = gitProject({ subdir: "app" });
  write(root, ".devflow/context.md", "SUB-BASE\n");
  const base = commit(repo, "ctx");
  write(root, ".devflow/context.md", "SUB-CHANGED\n");
  assert.equal(verificationContext(root, base, [".devflow/context.md"]), "SUB-BASE");
});
