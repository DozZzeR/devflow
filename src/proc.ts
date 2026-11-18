import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";
import { DevflowError } from "./errors.js";

const IS_WINDOWS = process.platform === "win32";

/** Variables a CLI needs to start and find its own config; nothing secret. Prefix entries end with "*". */
export const ENV_ALLOWLIST = [
  "PATH", "PATHEXT", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "COMMONPROGRAMFILES",
  "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "USERNAME", "USER",
  "LOGNAME", "SHELL", "TERM", "LANG", "LC_*", "TZ", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
  "OS", "XDG_*", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
];

export const API_KEY_VARS = {
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  codex: ["OPENAI_API_KEY"],
} as const;

function matches(name: string, pattern: string): boolean {
  const n = IS_WINDOWS ? name.toUpperCase() : name;
  const p = IS_WINDOWS ? pattern.toUpperCase() : pattern;
  return p.endsWith("*") ? n.startsWith(p.slice(0, -1)) : n === p;
}

/** Build a child environment from the allowlist plus explicitly passed names. Never inherits wholesale. */
export function buildChildEnv(parent: NodeJS.ProcessEnv, extraNames: readonly string[] = []): NodeJS.ProcessEnv {
  const allowed = [...ENV_ALLOWLIST, ...extraNames];
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && allowed.some((p) => matches(name, p))) env[name] = value;
  }
  return env;
}

function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (!IS_WINDOWS) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key ? env[key] : undefined;
}

/** Find an executable on PATH (with PATHEXT on Windows). Returns an absolute path or undefined. */
export function resolveCommand(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const isFile = (p: string) => existsSync(p) && statSync(p).isFile();
  if (isAbsolute(name) || name.includes("/") || name.includes("\\")) return isFile(name) ? name : undefined;
  const dirs = (envGet(env, "PATH") ?? "").split(delimiter).filter(Boolean);
  const exts = IS_WINDOWS
    ? (envGet(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const dir of dirs) {
    for (const ext of IS_WINDOWS && extname(name) ? ["", ...exts] : exts) {
      const candidate = join(dir, name + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

const CMD_UNSAFE = /["%!^&|<>\r\n]/;

export function isShim(path: string): boolean {
  return IS_WINDOWS && /\.(cmd|bat)$/i.test(path);
}

/**
 * Command line for `cmd.exe /d /v:off /s /c "<line>"`: every token double-quoted, the whole line
 * wrapped once more so /s strips only that outer pair. Rejects tokens cmd would still interpret.
 */
export function cmdLine(path: string, args: readonly string[]): string {
  for (const token of [path, ...args]) {
    if (CMD_UNSAFE.test(token)) {
      throw new DevflowError("unsafe_argument", `Refusing to pass ${JSON.stringify(token)} through cmd.exe.`);
    }
  }
  return `"${[path, ...args].map((t) => `"${t}"`).join(" ")}"`;
}

export interface LaunchOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  timeoutMs: number;
  onOutput: (chunk: string) => void;
}

export interface LaunchResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

function killTree(pid: number): void {
  if (IS_WINDOWS) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** Spawn, write stdin and close it, stream output, enforce the timeout by killing the whole tree. */
export function launch(opts: LaunchOptions): Promise<LaunchResult> {
  const resolved = resolveCommand(opts.command, opts.env);
  if (!resolved) {
    return Promise.reject(new DevflowError("cli_not_found", `"${opts.command}" was not found on PATH.`));
  }
  const viaCmd = isShim(resolved);
  const file = viaCmd ? (envGet(opts.env, "COMSPEC") ?? "cmd.exe") : resolved;
  const args = viaCmd ? ["/d", "/v:off", "/s", "/c", cmdLine(resolved, opts.args)] : [...opts.args];

  const started = Date.now();
  const child = spawn(file, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsVerbatimArguments: viaCmd,
    windowsHide: true,
    detached: !IS_WINDOWS,
  });

  return new Promise((resolvePromise, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, opts.timeoutMs);

    child.stdout.setEncoding("utf8").on("data", opts.onOutput);
    child.stderr.setEncoding("utf8").on("data", opts.onOutput);
    child.stdin.on("error", () => {
      /* child may exit before reading stdin */
    });
    child.stdin.end(opts.stdin);

    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code, timedOut, durationMs: Date.now() - started });
    });
  });
}
