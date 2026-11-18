import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock, readLock } from "../src/background.js";
import { DevflowError } from "../src/errors.js";
import { fakeAgentBin } from "./fake.js";
import { gitProject } from "./gitrepo.js";
import { tempDir } from "./helpers.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

function project() {
  const { root } = gitProject();
  const cfgPath = join(root, ".devflow", "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.openspec = { cli: "off" };
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const bin = fakeAgentBin(join(tempDir(), "bin"));
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
  const devflow = (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: "utf8" });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  return { root, env, devflow };
}

const waitFor = async (cond: () => boolean, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

test("--detach returns quickly with a run id; log shows output; the lock is released at the end", async () => {
  const { root, devflow } = project();
  devflow("start", "b1", "Add mul");
  const t0 = Date.now();
  const r = devflow("run", "b1", "--once", "--detach");
  assert.equal(r.code, 0, r.err);
  assert.ok(Date.now() - t0 < 10_000);
  assert.ok(JSON.parse(r.out).runId);
  assert.ok(await waitFor(() => !readLock(root, "b1")), "run did not finish");
  assert.match(devflow("log", "b1").out, /"stage":"explore"/);
});

test("simultaneous starts: exactly one wins", async () => {
  const { root, env } = project();
  spawnSync(process.execPath, [CLI, "start", "b2", "Add mul"], { cwd: root, env });
  const start = () =>
    new Promise<number | null>((res) => {
      const c = spawn(process.execPath, [CLI, "run", "b2", "--once", "--detach"], { cwd: root, env, stdio: "ignore" });
      c.on("close", res);
    });
  const codes = await Promise.all([start(), start(), start()]);
  assert.equal(codes.filter((c) => c === 0).length, 1, `exit codes ${codes.join(",")}`);
  await waitFor(() => !readLock(root, "b2"));
});

test("a stale lock (dead pid) is replaced; a live one is not", () => {
  const { root, devflow } = project();
  devflow("start", "b3", "x");
  acquireLock(root, "b3", { runId: "old", status: "running", startedAt: new Date().toISOString(), pid: 999_999 });
  acquireLock(root, "b3", { runId: "new", status: "running", startedAt: new Date().toISOString(), pid: process.pid });
  assert.equal(readLock(root, "b3")?.runId, "new");
  assert.throws(
    () => acquireLock(root, "b3", { runId: "third", status: "running", startedAt: new Date().toISOString(), pid: process.pid }),
    (e: unknown) => e instanceof DevflowError && e.reason === "run_active",
  );
});
