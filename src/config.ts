/** @file Parse project configuration, choose runner defaults and initialize the project directory. */

import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { DevflowError } from "./errors.js";

/** Project-local directory containing configuration and runtime records. */
export const DEVFLOW_DIR = ".devflow";
/** Filename used for the project configuration. */
export const CONFIG_FILE = "config.json";

/** Build the configuration schema for one vendor CLI and its model name. */
const modelRole = (runner: "claude" | "codex") =>
  z.strictObject({ runner: z.literal(runner), model: z.string().min(1) });

/** Validate the command template and model for a custom runner. */
const commandRole = z.strictObject({
  runner: z.literal("command"),
  model: z.string().min(1),
  command: z.string().min(1),
});

/** Select role settings by the runner discriminator. */
export const RoleSchema = z.discriminatedUnion("runner", [
  modelRole("claude"),
  modelRole("codex"),
  commandRole,
]);

/** Shared constraint for counts and timeout values that must exceed zero. */
const positiveInt = z.number().int().positive();

/** Identify a generated-output glob that would escape the permitted configuration scope. */
function outputGlobProblem(glob: string): boolean {
  const path = glob.replace(/^(?:\.\/)+/, "");
  return !path || path.startsWith("/") || /^[A-Za-z]:/.test(path)
    || path.includes("\\") || path.split("/").includes("..") || path.startsWith(DEVFLOW_DIR);
}

/** Validate nested project settings and dependencies between generation options. */
export const ConfigSchema = z.strictObject({
  /** Language tag used by stage prompts. */
  language: z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "expected a BCP 47 language tag").default("en"),
  /** Bindings from workflow roles to runnable model configurations. */
  roles: z.strictObject({
    explore: RoleSchema,
    design: RoleSchema,
    design_complex: RoleSchema.optional(),
    implement: RoleSchema,
    verify: RoleSchema,
    small: RoleSchema,
    review: RoleSchema.optional(),
  }),
  /** Attempt budgets and repeated gate failure threshold. */
  limits: z.strictObject({
    implement: positiveInt,
    verify: positiveInt,
    escalate_after: positiveInt,
  }),
  /** Trusted commands, file globs and exit codes used to establish test evidence. */
  test: z.strictObject({
    command: z.string().min(1),
    paths: z.array(z.string().min(1)).min(1),
    setup: z.string().min(1).optional(),
    setup_inputs: z
      .array(z.string().min(1))
      .default([
        "package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
        "requirements*.txt", "pyproject.toml", "poetry.lock", "uv.lock", "Pipfile.lock",
      ]),
    red_exit_codes: z.array(z.number().int()).min(1).optional(),
    timeout_seconds: positiveInt.max(86_400).default(1800),
  }),
  /** Optional deterministic generation command and the paths it owns. */
  build: z.strictObject({
    generate: z.string().min(1).optional(),
    outputs: z.array(z.string().refine(
      (glob) => !outputGlobProblem(glob),
      "expected a non-empty project-relative output glob without a .devflow prefix, backslashes, or parent segments",
    )).optional(),
  }).superRefine(({ generate, outputs }, ctx) => {
    if (!generate && outputs !== undefined) {
      ctx.addIssue({ code: "custom", path: ["generate"], message: "required when build.outputs is supplied" });
    }
  }).optional(),
  /** Policy for invoking the external OpenSpec validator. */
  openspec: z.strictObject({ cli: z.enum(["auto", "on", "off"]) }).optional(),
  /** Optional retention policy for runner logs. */
  logs: z.strictObject({ keep: positiveInt }).optional(),
  /** Provider-specific launch options and the environment allowlist. */
  runners: z
    .strictObject({
      claude: z.strictObject({ use_api_key: z.boolean().default(false) }).default({ use_api_key: false }),
      codex: z
        .strictObject({ use_api_key: z.boolean().default(false), ignore_user_config: z.boolean().default(false) })
        .default({ use_api_key: false, ignore_user_config: false }),
      env: z
        .strictObject({ pass: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_()]*$/, "expected a variable name")).default([]) })
        .default({ pass: [] }),
    })
    .default({ claude: { use_api_key: false }, codex: { use_api_key: false, ignore_user_config: false }, env: { pass: [] } }),
});

/** Validated runner and model selection for one workflow role. */
export type Role = z.infer<typeof RoleSchema>;
/** Normalized project settings after schema defaults and validation. */
export type Config = z.infer<typeof ConfigSchema>;

/** Choice of vendor preset when initializing a project. */
export type RunnerMode = "mixed" | "claude" | "codex";

/** Initial role assignments for mixed and single-vendor installations. */
const ROLE_PRESETS = {
  mixed: {
    explore: { runner: "claude", model: "haiku" },
    design: { runner: "claude", model: "opus" },
    design_complex: { runner: "claude", model: "opus" },
    implement: { runner: "claude", model: "sonnet" },
    verify: { runner: "codex", model: "gpt-6.2-sol" },
    small: { runner: "claude", model: "sonnet" },
  },
  claude: {
    explore: { runner: "claude", model: "haiku" },
    design: { runner: "claude", model: "opus" },
    design_complex: { runner: "claude", model: "opus" },
    implement: { runner: "claude", model: "sonnet" },
    verify: { runner: "claude", model: "opus" },
    small: { runner: "claude", model: "sonnet" },
  },
  codex: {
    explore: { runner: "codex", model: "gpt-5.6-luna" },
    design: { runner: "codex", model: "gpt-6.2-sol" },
    implement: { runner: "codex", model: "gpt-5.6-terra" },
    verify: { runner: "codex", model: "gpt-6.2-sol" },
    small: { runner: "codex", model: "gpt-5.6-terra" },
  },
} as const;

/** Starting values used when creating a project and building configuration fixtures. */
export const DEFAULT_CONFIG = {
  language: "en",
  roles: ROLE_PRESETS.mixed,
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

/** Apply defaults and convert schema failures into an invalid_config domain error. */
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

/** Read project JSON and distinguish missing configuration from invalid configuration. */
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

/** Return an independently mutable default configuration for the requested runner preset. */
export function defaultConfig(mode: RunnerMode = "mixed") {
  return { ...structuredClone(DEFAULT_CONFIG), roles: structuredClone(ROLE_PRESETS[mode]) };
}

/** Caller choices and CLI availability used during initialization. */
export interface InitOptions {
  /** Explicit runner choice; otherwise derived from `detected`. */
  runners?: RunnerMode;
  /** Which CLIs are on PATH. */
  detected: { claude: boolean; codex: boolean };
}

/** Report filesystem changes and runner selection from initialization. */
export interface InitResult {
  /** Absolute directory initialized as the project. */
  root: string;
  /** Whether this invocation created a new configuration file. */
  configCreated: boolean;
  /** How the project-local ignore file changed. */
  gitignore: "created" | "updated" | "unchanged";
  /** Runner preset selected when creating the configuration. */
  runners?: RunnerMode;
  /** Non-fatal setup conditions to show to the operator. */
  warnings: string[];
}

/** Runtime directories that initialization adds to the local ignore file. */
const GITIGNORE_LINES = ["runs/", "logs/", "jobs/"];

/** Inspect the entry itself, including links, or return null if the lookup fails. */
function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** Create `.devflow/config.json` and `.devflow/.gitignore` if missing; upgrade the latter. Never touches other files. */
export function initProject(dir: string, opts: InitOptions = { detected: { claude: true, codex: true } }): InitResult {
  const root = resolve(dir);
  const devflowDir = join(root, DEVFLOW_DIR);
  const dirStat = lstatOrNull(devflowDir);
  if (dirStat && (dirStat.isSymbolicLink() || !dirStat.isDirectory())) {
    throw new DevflowError("unsafe_path", `${devflowDir} is a link or not a directory.`);
  }
  if (!dirStat) mkdirSync(devflowDir);

  const warnings: string[] = [];
  const result: InitResult = { root, configCreated: false, gitignore: "unchanged", warnings };

  const gitignorePath = join(devflowDir, ".gitignore");
  const gi = lstatOrNull(gitignorePath);
  if (gi && (gi.isSymbolicLink() || !gi.isFile())) {
    throw new DevflowError("unsafe_path", `${gitignorePath} is a link or not a file.`);
  }

  const configPath = join(devflowDir, CONFIG_FILE);
  if (!lstatOrNull(configPath)) {
    let mode = opts.runners;
    if (!mode) {
      const { claude, codex } = opts.detected;
      mode = claude && codex ? "mixed" : codex ? "codex" : claude ? "claude" : "mixed";
      if (!claude && !codex) warnings.push("No supported CLI (claude, codex) found on PATH; wrote mixed defaults.");
    }
    writeFileSync(configPath, JSON.stringify(defaultConfig(mode), null, 2) + "\n", { flag: "wx" });
    result.configCreated = true;
    result.runners = mode;
  }

  if (!gi) {
    writeFileSync(gitignorePath, GITIGNORE_LINES.join("\n") + "\n", { flag: "wx" });
    result.gitignore = "created";
  } else {
    const current = readFileSync(gitignorePath, "utf8");
    const lines = current.split(/\r?\n/).map((l) => l.trim());
    const missing = GITIGNORE_LINES.filter((l) => !lines.includes(l));
    if (missing.length) {
      const prefix = current.length && !current.endsWith("\n") ? "\n" : "";
      appendFileSync(gitignorePath, prefix + missing.join("\n") + "\n");
      result.gitignore = "updated";
    }
  }
  return result;
}
