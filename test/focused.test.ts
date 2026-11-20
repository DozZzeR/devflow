/** @file Check the focused test command matcher and the repository focused test script. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { matchFocused, MAX_FOCUSED_FILES } from "../src/focused.js";

/** Focused template and globs used by the matcher cases. */
const focused = { template: "node scripts/test-focused.mjs {files}", paths: ["test/**", "**/*.test.*"] };
/** Command prefix of the template. */
const P = "node scripts/test-focused.mjs";

test("matchFocused returns the files of an allowed focused command", () => {
  assert.deepEqual(matchFocused(`${P} test/hook.test.ts`, focused), ["test/hook.test.ts"]);
  assert.deepEqual(matchFocused(`  ${P} test/a.test.ts test/b.test.ts  `, focused), ["test/a.test.ts", "test/b.test.ts"]);
  const many = Array.from({ length: 64 }, (_, i) => `test/f${i}.test.ts`);
  assert.equal(matchFocused(`${P} ${many.join(" ")}`, focused)?.length, 64);
  assert.equal(MAX_FOCUSED_FILES, 64);
});

test("matchFocused rejects every command that is not the template with safe test files", () => {
  const denied = [
    P,
    `${P} `,
    `${P}  test/a.ts`,
    `${P} test/a.ts  test/b.ts`,
    `${P} src/hook.ts`,
    `${P} test/../src/hook.ts`,
    `${P} test/./a.ts`,
    `${P} test//a.ts`,
    `${P} /abs/test/x.test.ts`,
    `${P} -r x`,
    `${P} --test/a.ts`,
    `${P} test/*.ts`,
    `${P} test/?.ts`,
    `${P} test/a.ts;rm`,
    `${P} test/a.ts && rm -rf src`,
    `${P} test/a.ts | cat`,
    `${P} test/a.ts\nrm x`,
    `${P} $(x)`,
    `${P} "test/a.ts"`,
    `${P} 'test/a.ts'`,
    `${P} test\\a.ts`,
    `${P} test/a.ts > out`,
    `${P} test/{a,b}.ts`,
    `${P} ~/test/a.ts`,
    `${P} \`x\``,
    `${P} {files}`,
    `${P} ${Array.from({ length: 65 }, (_, i) => `test/f${i}.test.ts`).join(" ")}`,
    "node scripts/other.mjs test/a.ts",
    "npm test",
    "",
  ];
  for (const command of denied) assert.equal(matchFocused(command, focused), undefined, JSON.stringify(command));
  assert.equal(matchFocused(`${P} {files}`, focused), undefined);
});

test("matchFocused matches a template with a literal suffix and rejects a malformed template", () => {
  const withSuffix = { template: "run {files} --quiet", paths: ["test/**"] };
  assert.deepEqual(matchFocused("run test/a.ts --quiet", withSuffix), ["test/a.ts"]);
  assert.equal(matchFocused("run test/a.ts", withSuffix), undefined);
  assert.equal(matchFocused("run --quiet", withSuffix), undefined);
  assert.equal(matchFocused("run test/a.ts", { template: "run", paths: ["test/**"] }), undefined);
  assert.equal(matchFocused("run test/a.ts test/b.ts", { template: "run {files} {files}", paths: ["test/**"] }), undefined);
});

test("the repository focused script rejects a non-test argument before any work", () => {
  const r = spawnSync(process.execPath, ["scripts/test-focused.mjs", "README.md"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /README\.md/);
  const mixed = spawnSync(process.execPath, ["scripts/test-focused.mjs", "test/focused.test.ts", "test/no-such-file.test.ts"], { encoding: "utf8" });
  assert.equal(mixed.status, 2);
  assert.match(mixed.stderr, /no-such-file\.test\.ts/);
  assert.equal(mixed.stdout, "", "no compiler or test runner output: nothing was launched");
  // A source module or a non-test file under test/ is not a test file.
  for (const arg of ["src/hook.ts", "test/helpers.ts"]) {
    const r2 = spawnSync(process.execPath, ["scripts/test-focused.mjs", arg], { encoding: "utf8" });
    assert.equal(r2.status, 2, arg);
    assert.match(r2.stderr, new RegExp(arg.replace(/[./]/g, "\\$&")));
    assert.equal(r2.stdout, "", arg);
  }
  const none = spawnSync(process.execPath, ["scripts/test-focused.mjs"], { encoding: "utf8" });
  assert.notEqual(none.status, 0);
});

test("the repository config sets the focused command", () => {
  const config = JSON.parse(readFileSync(".devflow/config.json", "utf8")) as { test: { focused?: string } };
  assert.equal(config.test.focused, "node scripts/test-focused.mjs {files}");
});
