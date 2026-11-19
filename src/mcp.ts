import { dirname, relative, resolve, sep, isAbsolute } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { findProjectRoot } from "./config.js";
import { DevflowError } from "./errors.js";
import { latestRunLog, readLock, startDetached } from "./background.js";
import { jobActive, readJob, selfScript, startJob, tail } from "./jobs.js";
import { nextStage } from "./lifecycle.js";
import { loadConfig } from "./config.js";
import { loadTask, validateId } from "./store.js";

export interface McpContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  now: () => string;
  /** The CLI entry (passed in: importing cli.js from here would deadlock on its top-level await). */
  run: CliRunner;
}

export type CliRunner = (argv: string[], io: { cwd: string; env: NodeJS.ProcessEnv; out: (s: string) => void; err: (s: string) => void; now: () => string; readStdin: () => Promise<string> }) => Promise<number>;

/** The plugin's own install directory (bundle: <plugin>/bin/devflow.mjs); never a project. */
function pluginRoot(): string | undefined {
  const script = selfScript();
  return /[\\/]bin[\\/]devflow\.mjs$/.test(script) ? resolve(dirname(script), "..") : undefined;
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes(".."));
}

/** projectDir → CLAUDE_PROJECT_DIR → server cwd; then search upwards for .devflow/. */
export function resolveProject(ctx: McpContext, projectDir?: string): string {
  const start = projectDir ?? ctx.env.CLAUDE_PROJECT_DIR ?? ctx.cwd;
  const root = findProjectRoot(start);
  const plugin = pluginRoot();
  if (plugin && inside(root, plugin)) {
    throw new DevflowError("no_project", "The working directory is the devflow plugin, not a project: pass projectDir.");
  }
  return root;
}

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] });
const fail = (reason: string, message: string) => ({ ...text({ error: { reason, message } }), isError: true });

function guard<A>(fn: (a: A) => Promise<ReturnType<typeof text>> | ReturnType<typeof text>) {
  return async (a: A) => {
    try {
      return await fn(a);
    } catch (e) {
      if (e instanceof DevflowError) return fail(e.reason, e.message);
      return fail("internal_error", (e as Error).message);
    }
  };
}

const HUMAN_ONLY = "Records a human decision: call it ONLY when the user has explicitly told you to, in this conversation, for this task and plan revision. Never call it on your own judgement.";

export async function serveMcp(ctx: McpContext): Promise<void> {
  const run = ctx.run;
  const server = new McpServer({ name: "devflow", version: "0.0.0" });
  const project = { projectDir: z.string().optional().describe("Project directory (where .devflow/ lives). Pass your working directory.") };

  /** Run a quick CLI command in-process and return its JSON output, or a tool error. */
  const cli = async (root: string, argv: string[]) => {
    let out = "";
    let err = "";
    const code = await run([...argv, "--json"], {
      cwd: root,
      env: ctx.env,
      out: (s) => (out += s + "\n"),
      err: (s) => (err += s + "\n"),
      now: ctx.now,
      readStdin: async () => "",
    });
    if (code === 0) return text(out.trim());
    try {
      const e = JSON.parse(err.trim()) as { error: { reason: string; message: string } };
      return fail(e.error.reason, e.error.message);
    } catch {
      return fail("command_failed", (err || out).trim());
    }
  };

  server.registerTool("devflow_status", { description: "Show devflow tasks (or one task) as JSON.", inputSchema: { ...project, id: z.string().optional() } },
    guard(async ({ projectDir, id }) => cli(resolveProject(ctx, projectDir), id ? ["status", id] : ["status"])));

  server.registerTool("devflow_start", {
    description: "Start a devflow task.",
    inputSchema: { ...project, id: z.string(), description: z.string(), tier: z.enum(["small", "medium", "complex"]).optional(), tracker: z.string().optional(), zone: z.array(z.string()).optional() },
  }, guard(async ({ projectDir, id, description, tier, tracker, zone }) => {
    const argv = ["start", id, description, ...(tier ? ["--tier", tier] : []), ...(tracker ? ["--tracker", tracker] : []), ...(zone ?? []).flatMap((z) => ["--zone", z])];
    return cli(resolveProject(ctx, projectDir), argv);
  }));

  server.registerTool("devflow_nodes", { description: "List the numbered OpenSpec tasks in the current plan.", inputSchema: { ...project, id: z.string() } },
    guard(async ({ projectDir, id }) => cli(resolveProject(ctx, projectDir), ["nodes", id])));

  server.registerTool("devflow_next", { description: "Next stage of a task (read-only).", inputSchema: { ...project, id: z.string() } },
    guard(async ({ projectDir, id }) => cli(resolveProject(ctx, projectDir), ["next", id])));

  server.registerTool("devflow_approve", {
    description: `Approve the current plan of a task. ${HUMAN_ONLY}`,
    inputSchema: { ...project, id: z.string(), revision: z.number().int().positive().describe("Plan revision the user approved (from devflow_status).") },
  }, guard(async ({ projectDir, id, revision }) => cli(resolveProject(ctx, projectDir), ["approve", id, "--revision", String(revision)])));

  server.registerTool("devflow_reject", {
    description: `Send the plan back to design with the user's feedback. ${HUMAN_ONLY}`,
    inputSchema: { ...project, id: z.string(), revision: z.number().int().positive(), node: z.string().optional(), feedback: z.string() },
  }, guard(async ({ projectDir, id, revision, feedback, node }) => cli(resolveProject(ctx, projectDir), ["approve", id, "--revision", String(revision), "--reject", feedback, ...(node ? ["--node", node] : [])])));

  server.registerTool("devflow_delegate_approval", {
    description: `Let a reviewer model approve or reject this task's plans (to: model), or give approval back to the user (to: human). ${HUMAN_ONLY}`,
    inputSchema: { ...project, id: z.string(), to: z.enum(["model", "human"]) },
  }, guard(async ({ projectDir, id, to }) => cli(resolveProject(ctx, projectDir), ["delegate-approval", id, "--to", to])));

  server.registerTool("devflow_run", {
    description: "Run the task's stages in the background until a human is needed, a stage fails or it is done. Returns at once; watch with devflow_run_status and devflow_log.",
    inputSchema: { ...project, id: z.string(), once: z.boolean().optional() },
  }, guard(({ projectDir, id, once }) => {
    const root = resolveProject(ctx, projectDir);
    loadTask(root, id);
    return text(startDetached(root, id, once ? ["--once"] : [], ctx.env));
  }));

  server.registerTool("devflow_run_status", { description: "Whether a background run of the task is active, and the task's next stage.", inputSchema: { ...project, id: z.string() } },
    guard(({ projectDir, id }) => {
      const root = resolveProject(ctx, projectDir);
      const lock = readLock(root, id) ?? null;
      const next = nextStage(loadTask(root, id), loadConfig(root));
      const log = latestRunLog(root, id);
      return text({ id, active: !!lock, lock, next, lastLines: log ? tail(log, 5) : "" });
    }));

  server.registerTool("devflow_gate", {
    description: "Run gates (zone, tests, rollback or all) as a background job. Returns a job id at once.",
    inputSchema: { ...project, id: z.string(), gate: z.enum(["zone", "tests", "rollback", "all"]).optional() },
  }, guard(({ projectDir, id, gate }) => text(startJob(resolveProject(ctx, projectDir), ["gate", id, gate ?? "all", "--json"], ctx.env))));

  server.registerTool("devflow_job_status", { description: "Status of a background job started by devflow_gate or devflow_roles_propose.", inputSchema: { ...project, jobId: z.string() } },
    guard(({ projectDir, jobId }) => {
      const root = resolveProject(ctx, projectDir);
      const job = readJob(root, jobId);
      const safe = inside(resolve(job.log), resolve(root, ".devflow"));
      return text({ ...job, active: jobActive(job), lastLines: safe ? tail(job.log, 5) : "" });
    }));

  server.registerTool("devflow_log", {
    description: "Tail of the latest run log of a task, or of a job log.",
    inputSchema: { ...project, id: z.string().optional(), jobId: z.string().optional(), lines: z.number().int().positive().max(2000).optional() },
  }, guard(({ projectDir, id, jobId, lines }) => {
    const root = resolveProject(ctx, projectDir);
    if (id) validateId(id);
    const path = jobId ? readJob(root, jobId).log : id ? latestRunLog(root, id) : undefined;
    if (path && !inside(resolve(path), resolve(root, ".devflow"))) throw new DevflowError("unsafe_path", "Log path is outside the project's .devflow folder.");
    if (!path) throw new DevflowError("no_log", "No log found: pass id (task) or jobId.");
    return text(tail(path, lines ?? 200));
  }));

  server.registerTool("devflow_roles", { description: "Show the role → runner/model layout.", inputSchema: { ...project } },
    guard(async ({ projectDir }) => cli(resolveProject(ctx, projectDir), ["roles"])));

  server.registerTool("devflow_roles_propose", {
    description: "Propose a role layout from the available CLIs and models. probe: actually call each model (background job). apply: write the proposal.",
    inputSchema: { ...project, probe: z.boolean().optional(), apply: z.boolean().optional() },
  }, guard(async ({ projectDir, probe, apply }) => {
    const root = resolveProject(ctx, projectDir);
    const argv = ["roles", "propose", ...(probe ? ["--probe"] : []), ...(apply ? ["--apply"] : [])];
    return probe ? text(startJob(root, [...argv, "--json"], ctx.env)) : cli(root, argv);
  }));

  server.registerTool("devflow_roles_set", {
    description: "Set one role's runner and model.",
    inputSchema: { ...project, role: z.string(), runner: z.string().describe("claude, codex or command"), model: z.string(), command: z.string().optional() },
  }, guard(async ({ projectDir, role, runner, model, command }) =>
    cli(resolveProject(ctx, projectDir), ["roles", "set", role, runner, model, ...(command ? ["--command", command] : [])])));

  await server.connect(new StdioServerTransport());
  await new Promise<void>((resolveDone) => process.stdin.on("close", () => resolveDone()));
}
