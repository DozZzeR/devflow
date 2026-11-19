import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fakeAgentBin } from "./fake.js";
import { gitProject, sh } from "./gitrepo.js";
import { tempDir } from "./helpers.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

async function connect(cwd: string, env: Record<string, string>) {
  const client = new Client({ name: "devflow-test", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], cwd, env });
  await client.connect(transport);
  return client;
}

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
const call = async (c: Client, name: string, args: Record<string, unknown>) => {
  const r = (await c.callTool({ name, arguments: args })) as ToolResult;
  const raw = r.content[0]!.text;
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    json = raw; // plain-text results such as log tails
  }
  return { error: r.isError === true, json };
};

function project() {
  const { root } = gitProject();
  const cfgPath = join(root, ".devflow", "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.openspec = { cli: "off" };
  cfg.runners = { env: { pass: ["FAKE_AGENT_SLEEP"] } };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  sh(root, "git", ["add", "-A"]);
  sh(root, "git", ["commit", "-q", "-m", "config"]);
  const bin = fakeAgentBin(join(tempDir(), "bin"));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
  delete env.CLAUDE_PROJECT_DIR;
  return { root, env };
}

test("tools are listed; projectDir locates the project from an unrelated cwd", async () => {
  const { root, env } = project();
  const c = await connect(tempDir(), env);
  try {
    const names = (await c.listTools()).tools.map((t) => t.name);
    for (const n of ["devflow_nodes", "devflow_status", "devflow_start", "devflow_run", "devflow_log", "devflow_approve", "devflow_roles_set", "devflow_job_status"]) {
      assert.ok(names.includes(n), n);
    }
    const approve = (await c.listTools()).tools.find((t) => t.name === "devflow_approve")!;
    assert.match(approve.description ?? "", /ONLY when the user has explicitly told you/);
    assert.equal((await call(c, "devflow_start", { projectDir: root, id: "m1", description: "Add mul" })).error, false);
    const status = await call(c, "devflow_status", { projectDir: root, id: "m1" });
    assert.equal(status.json.status, "NEW");
    const noProject = await call(c, "devflow_status", {});
    assert.deepEqual([noProject.error, noProject.json.error.reason], [true, "no_project"]);
  } finally {
    await c.close();
  }
});

test("CLAUDE_PROJECT_DIR is used when projectDir is absent; domain errors carry the reason", async () => {
  const { root, env } = project();
  const c = await connect(tempDir(), { ...env, CLAUDE_PROJECT_DIR: root });
  try {
    await call(c, "devflow_start", { id: "m2", description: "x" });
    const wrong = await call(c, "devflow_approve", { id: "m2", revision: 1 });
    assert.deepEqual([wrong.error, wrong.json.error.reason], [true, "not_awaiting_approval"]);
  } finally {
    await c.close();
  }
});

test("devflow_run and devflow_gate return at once; status and log follow the background work", async () => {
  const { root, env } = project();
  const c = await connect(root, { ...env, FAKE_AGENT_SLEEP: "3000" });
  try {
    await call(c, "devflow_start", { projectDir: root, id: "m3", description: "Add mul" });
    const t0 = Date.now();
    const run = await call(c, "devflow_run", { projectDir: root, id: "m3", once: true });
    assert.equal(run.error, false);
    assert.ok(Date.now() - t0 < 10_000);
    assert.ok(run.json.runId);
    const st = await call(c, "devflow_run_status", { projectDir: root, id: "m3" });
    assert.equal(st.json.id, "m3");
    let done = false;
    for (let i = 0; i < 100 && !done; i++) {
      await new Promise((r) => setTimeout(r, 300));
      done = !(await call(c, "devflow_run_status", { projectDir: root, id: "m3" })).json.active;
    }
    assert.ok(done, "run did not finish");
    const log = await call(c, "devflow_log", { projectDir: root, id: "m3" });
    assert.match(String(log.json), /explore/);

    const gate = await call(c, "devflow_gate", { projectDir: root, id: "m3", gate: "zone" });
    assert.ok(gate.json.jobId);
    let job: any;
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 300));
      job = (await call(c, "devflow_job_status", { projectDir: root, jobId: gate.json.jobId })).json;
      if (!job.active && job.endedAt) break;
    }
    assert.ok(job.endedAt, JSON.stringify(job));
  } finally {
    await c.close();
  }
});

test("devflow_roles_set changes the config", async () => {
  const { root, env } = project();
  const c = await connect(root, env);
  try {
    await call(c, "devflow_roles_set", { projectDir: root, role: "verify", runner: "claude", model: "opus" });
    const roles = await call(c, "devflow_roles", { projectDir: root });
    assert.equal(roles.json.verify.model, "opus");
  } finally {
    await c.close();
  }
});

test("devflow_roles_set with an unknown runner returns invalid_config", async () => {
  const { root, env } = project();
  const c = await connect(root, env);
  try {
    const r = await call(c, "devflow_roles_set", { projectDir: root, role: "verify", runner: "gemini", model: "x" });
    assert.deepEqual([r.error, r.json.error.reason], [true, "invalid_config"]);
  } finally {
    await c.close();
  }
});
