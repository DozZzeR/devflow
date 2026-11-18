import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";
import { DevflowError } from "./errors.js";

const IS_WINDOWS = process.platform === "win32";

/** Variables a CLI needs to start and find its own config; nothing secret. Explicit names only. */
export const ENV_ALLOWLIST = [
  "PATH", "PATHEXT", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "COMMONPROGRAMFILES",
  "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "USERNAME", "USER",
  "LOGNAME", "SHELL", "TERM", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TZ",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "CODEX_HOME", "CLAUDE_CONFIG_DIR",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
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
  const isFile = (p: string) => {
    if (!existsSync(p)) return false;
    const st = statSync(p);
    return st.isFile() && (IS_WINDOWS || (st.mode & 0o111) !== 0);
  };
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
  onOutput: (chunk: string, stream: "stdout" | "stderr") => void;
  /** How long to wait for the process to close after the tree kill before giving up (default 5 s). */
  teardownMs?: number;
}

export interface LaunchResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Set when the tree kill could not be confirmed; descendants may still be running. */
  killFailed?: boolean;
}

/** Longest delay setTimeout accepts without overflowing to ~1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/** Kill the process tree. Returns false when the kill could not be confirmed. */
export function killTree(pid: number): boolean {
  if (IS_WINDOWS) {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
    const r = spawnSync(join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      env: { SystemRoot: systemRoot },
      windowsHide: true,
      timeout: 5_000,
    });
    return r.status === 0;
  }
  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

/** Spawn, write stdin and close it, stream output, enforce the timeout by killing the whole tree. */
export function launch(opts: LaunchOptions): Promise<LaunchResult> {
  if (!(opts.timeoutMs > 0) || opts.timeoutMs > MAX_TIMER_MS) {
    return Promise.reject(new DevflowError("invalid_timeout", `Timeout must be between 1 ms and ${MAX_TIMER_MS} ms.`));
  }
  const resolved = resolveCommand(opts.command, opts.env);
  if (!resolved) {
    return Promise.reject(new DevflowError("cli_not_found", `"${opts.command}" was not found on PATH.`));
  }
  const viaCmd = isShim(resolved);
  const file = viaCmd ? (envGet(opts.env, "COMSPEC") ?? "cmd.exe") : resolved;
  const args = viaCmd ? ["/d", "/v:off", "/s", "/c", cmdLine(resolved, opts.args)] : [...opts.args];
  return spawnAndWait(file, args, viaCmd, opts);
}

export type ShellOptions = Omit<LaunchOptions, "command" | "args">;

/**
 * Run a user-configured shell command (the project's test command). Windows: `cmd.exe /d /s /c "<command>"`
 * verbatim, so quotes inside the command survive; POSIX: `/bin/sh -c`.
 */
export function launchShell(command: string, opts: ShellOptions): Promise<LaunchResult> {
  if (!(opts.timeoutMs > 0) || opts.timeoutMs > MAX_TIMER_MS) {
    return Promise.reject(new DevflowError("invalid_timeout", `Timeout must be between 1 ms and ${MAX_TIMER_MS} ms.`));
  }
  if (/[\r\n]/.test(command)) return Promise.reject(new DevflowError("invalid_command", "Shell command must be one line."));
  if (IS_WINDOWS) {
    const comspec = envGet(opts.env, "COMSPEC") ?? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    return spawnAndWait(comspec, ["/d", "/s", "/c", `"${command}"`], true, opts);
  }
  return spawnAndWait("/bin/sh", ["-c", command], false, opts);
}

function spawnAndWait(file: string, args: string[], verbatim: boolean, opts: ShellOptions): Promise<LaunchResult> {
  const viaCmd = verbatim;
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
    let killFailed = false;
    let settled = false;
    let teardown: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (teardown) clearTimeout(teardown);
      if (outputError) {
        reject(new DevflowError("output_error", `Could not record process output: ${outputError.message}`));
        return;
      }
      const result: LaunchResult = { exitCode, timedOut, durationMs: Date.now() - started };
      if (killFailed) result.killFailed = true;
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      const killed = child.pid !== undefined && killTree(child.pid);
      if (!killed) {
        child.kill("SIGKILL");
        killFailed = true;
      }
      // Descendants can keep the pipes open; never wait for them forever.
      teardown = setTimeout(() => {
        killFailed = true;
        child.stdout.destroy();
        child.stderr.destroy();
        finish(null);
      }, opts.teardownMs ?? 5_000);
    }, opts.timeoutMs);

    // A failing output handler (for example a log write error) must not escape the promise.
    let outputError: Error | undefined;
    const emit = (c: string, stream: "stdout" | "stderr") => {
      if (outputError) return;
      try {
        opts.onOutput(c, stream);
      } catch (e) {
        outputError = e as Error;
      }
    };
    child.stdout.setEncoding("utf8").on("data", (c: string) => emit(c, "stdout"));
    child.stderr.setEncoding("utf8").on("data", (c: string) => emit(c, "stderr"));
    child.stdin.on("error", () => {
      /* child may exit before reading stdin */
    });
    child.stdin.end(opts.stdin);

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (teardown) clearTimeout(teardown);
      reject(e);
    });
    child.on("close", (code) => finish(timedOut ? null : code));
  });
}
