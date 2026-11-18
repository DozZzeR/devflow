import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
    setup: z.string().min(1).optional(),
    setup_inputs: z
      .array(z.string().min(1))
      .default([
        "package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
        "requirements*.txt", "pyproject.toml", "poetry.lock", "uv.lock", "Pipfile.lock",
      ]),
    red_exit_codes: z.array(z.number().int()).min(1).optional(),
    timeout_seconds: positiveInt.default(1800),
  }),
  openspec: z.strictObject({ cli: z.enum(["auto", "on", "off"]) }).optional(),
  logs: z.strictObject({ keep: positiveInt }).optional(),
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

export type Role = z.infer<typeof RoleSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export type RunnerMode = "mixed" | "claude" | "codex";

const ROLE_PRESETS = {
  mixed: {
    explore: { runner: "claude", model: "haiku" },
    design: { runner: "claude", model: "opus" },
    design_complex: { runner: "claude", model: "fable" },
    implement: { runner: "claude", model: "sonnet" },
    verify: { runner: "codex", model: "gpt-6.2-sol" },
    small: { runner: "claude", model: "sonnet" },
  },
  claude: {
    explore: { runner: "claude", model: "haiku" },
    design: { runner: "claude", model: "opus" },
    design_complex: { runner: "claude", model: "fable" },
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

export function defaultConfig(mode: RunnerMode = "mixed") {
  return { ...structuredClone(DEFAULT_CONFIG), roles: structuredClone(ROLE_PRESETS[mode]) };
}

export interface InitOptions {
  /** Explicit runner choice; otherwise derived from `detected`. */
  runners?: RunnerMode;
  /** Which CLIs are on PATH. */
  detected: { claude: boolean; codex: boolean };
}

export interface InitResult {
  root: string;
  configCreated: boolean;
  gitignore: "created" | "updated" | "unchanged";
  runners?: RunnerMode;
  warnings: string[];
}

const GITIGNORE_LINES = ["runs/", "logs/"];

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
