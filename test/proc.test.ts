import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildChildEnv, cmdLine, launch, resolveCommand } from "../src/proc.js";
import { DevflowError } from "../src/errors.js";
import { fakeBin, testEnv } from "./fake.js";
import { tempDir } from "./helpers.js";


test("child env is an allowlist: secrets dropped, system vars and passed names kept", () => {
  const env = buildChildEnv(
    { PATH: "/bin", USERPROFILE: "/u", MEMPALACE_TOKEN: "x", GITHUB_TOKEN: "y", ANTHROPIC_API_KEY: "k", LC_ALL: "C", HTTPS_PROXY: "p", XDG_TOKEN: "t", LC_SECRET: "s" },
    ["HTTPS_PROXY"],
  );
  assert.deepEqual(Object.keys(env).sort(), ["HTTPS_PROXY", "LC_ALL", "PATH", "USERPROFILE"]);
});

test("resolveCommand finds executables on the given PATH only", () => {
  const bin = fakeBin(join(tempDir(), "bin"), ["codex"]);
  assert.ok(resolveCommand("codex", testEnv(bin)));
  assert.equal(resolveCommand("claude", testEnv(bin)), undefined);
});

test("cmd line quotes every token and refuses cmd metacharacters", () => {
  assert.equal(cmdLine("C:\\Program Files\\x\\codex.cmd", ["exec", "-m", "a(b)"]), '""C:\\Program Files\\x\\codex.cmd" "exec" "-m" "a(b)""');
  for (const bad of ["a&b", "a|b", "a>b", "a^b", "50%", "x!y", 'q"q', "a\nb"]) {
    assert.throws(() => cmdLine("C:\\x.cmd", [bad]), (e: unknown) => e instanceof DevflowError && e.reason === "unsafe_argument", bad);
  }
  assert.throws(() => cmdLine("C:\\a&b\\x.cmd", []), (e: unknown) => e instanceof DevflowError);
});

test("launch delivers the prompt on stdin, closes it, and works through a shim in a path with spaces", async () => {
  const dir = join(tempDir(), "with space (x86)", "bin");
  const bin = fakeBin(dir, ["codex"]);
  const record = join(tempDir(), "record.json");
  const env = testEnv(bin, { FAKE_RECORD: record });
  let out = "";
  const r = await launch({ command: "codex", args: ["exec", "-"], cwd: tempDir(), env, stdin: "hello prompt", timeoutMs: 20_000, onOutput: (c) => (out += c) });
  assert.equal(r.exitCode, 0, out);
  const rec = JSON.parse(readFileSync(record, "utf8"));
  assert.equal(rec.stdin, "hello prompt");
  assert.deepEqual(rec.args, ["exec", "-"]);
});

test("timeout kills the whole process tree", async () => {
  const bin = fakeBin(join(tempDir(), "bin"), ["codex"]);
  const pidFile = join(tempDir(), "grandchild.pid");
  const env = testEnv(bin, { FAKE_SLEEP: "60000", FAKE_GRANDCHILD: pidFile });
  const t0 = Date.now();
  const r = await launch({ command: "codex", args: [], cwd: tempDir(), env, stdin: "", timeoutMs: 2_000, teardownMs: 3_000, onOutput: () => {} });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 15_000, `timeout took ${Date.now() - t0} ms; the fake sleeps 60 s`);
  assert.ok(existsSync(pidFile));
  const pid = Number(readFileSync(pidFile, "utf8"));
  await new Promise((res) => setTimeout(res, 500));
  assert.throws(() => process.kill(pid, 0), "grandchild should be gone");
});

test("missing CLI is a clear error", async () => {
  const empty = join(tempDir(), "empty");
  mkdirSync(empty);
  await assert.rejects(
    launch({ command: "codex", args: [], cwd: empty, env: testEnv(empty), stdin: "", timeoutMs: 1000, onOutput: () => {} }),
    (e: unknown) => e instanceof DevflowError && e.reason === "cli_not_found",
  );
});
