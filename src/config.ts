import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { DevflowError } from "./errors.js";

export const DEVFLOW_DIR = ".devflow";
export const CONFIG_FILE = "config.json";

const modelRole = (runner: "claude" | "codex") =>
  z.strictObject({ runner: z.literal(runner), model: z.string().min(1) });

const commandRole = z.strictObject({
  runner: z.literal("command"),
  model: z.string().min(1),
  command: z.string().min(1),
});

export const RoleSchema = z.discriminatedUnion("runner", [
  modelRole("claude"),
  modelRole("codex"),
  commandRole,
]);

const positiveInt = z.number().int().positive();

export const ConfigSchema = z.strictObject({
  language: z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "expected a BCP 47 language tag").default("en"),
  roles: z.strictObject({
    explore: RoleSchema,
    design: RoleSchema,
    design_complex: RoleSchema.optional(),
    implement: RoleSchema,
    verify: RoleSchema,
    small: RoleSchema,
  }),
  limits: z.strictObject({
    implement: positiveInt,
    verify: positiveInt,
    escalate_after: positiveInt,
  }),
  test: z.strictObject({
    command: z.string().min(1),
    paths: z.array(z.string().min(1)).min(1),
  }),
  openspec: z.strictObject({ cli: z.enum(["auto", "on", "off"]) }).optional(),
  logs: z.strictObject({ keep: positiveInt }).optional(),
});

export type Role = z.infer<typeof RoleSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG = {
  language: "en",
  roles: {
    explore: { runner: "claude", model: "haiku" },
    design: { runner: "claude", model: "opus" },
    design_complex: { runner: "claude", model: "fable" },
    implement: { runner: "claude", model: "sonnet" },
    verify: { runner: "codex", model: "gpt-5-codex" },
    small: { runner: "claude", model: "sonnet" },
  },
  limits: { implement: 3, verify: 2, escalate_after: 2 },
  test: {
    command: "npm test",
    paths: ["test/**", "tests/**", "**/*.test.*", "**/test_*.py"],
  },
  openspec: { cli: "auto" },
  logs: { keep: 20 },
} as const satisfies z.input<typeof ConfigSchema>;

/** Turn zod issues into "path: message" lines; unknown keys get one line each. */
export function formatIssues(error: z.ZodError): string[] {
  const lines: string[] = [];
  for (const issue of error.issues) {
    const base = issue.path.map(String);
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) lines.push(`${[...base, key].join(".")}: unknown field`);
    } else {
      lines.push(`${base.join(".") || "(root)"}: ${issue.message}`);
    }
  }
  return lines;
}

export function parseConfig(raw: unknown): Config {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const problems = formatIssues(result.error);
    throw new DevflowError("invalid_config", `Invalid ${DEVFLOW_DIR}/${CONFIG_FILE}:\n  ${problems.join("\n  ")}`, problems);
  }
  return result.data;
}

/** Nearest ancestor of `start` (inclusive) that contains a `.devflow/` directory. */
export function findProjectRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, DEVFLOW_DIR);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new DevflowError("no_project", `No ${DEVFLOW_DIR}/ found from ${resolve(start)} upwards. Run "devflow init" first.`);
    }
    dir = parent;
  }
}

export function loadConfig(root: string): Config {
  const file = join(root, DEVFLOW_DIR, CONFIG_FILE);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new DevflowError("no_config", `Missing ${file}. Run "devflow init".`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new DevflowError("invalid_config", `${file} is not valid JSON: ${(e as Error).message}`);
  }
  return parseConfig(raw);
}

export interface InitResult {
  root: string;
  configCreated: boolean;
  gitignoreCreated: boolean;
}

/** Create `.devflow/config.json` and `.devflow/.gitignore` if missing. Never touches other files. */
export function initProject(dir: string): InitResult {
  const root = resolve(dir);
  const devflowDir = join(root, DEVFLOW_DIR);
  mkdirSync(devflowDir, { recursive: true });

  const configPath = join(devflowDir, CONFIG_FILE);
  let configCreated = false;
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", { flag: "wx" });
    configCreated = true;
  }

  const gitignorePath = join(devflowDir, ".gitignore");
  let gitignoreCreated = false;
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, "runs/\n", { flag: "wx" });
    gitignoreCreated = true;
  }
  return { root, configCreated, gitignoreCreated };
}
