/** @file Install local vendor stand-ins for process-level runner and workflow tests. */

import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Path to the controllable fake vendor CLI script. */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures", "fake-cli.cjs");
/** Path to the stand-in that writes stage artifacts for end-to-end tests. */
const AGENT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures", "fake-agent.cjs");

/** Fake `codex`/`claude` that act out devflow stages (see fixtures/fake-agent.cjs). */
export function fakeAgentBin(dir: string, names: string[] = ["codex", "claude"]): string {
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "fake-agent.cjs");
  copyFileSync(AGENT, script);
  for (const name of names) {
    if (process.platform === "win32") {
      writeFileSync(join(dir, `${name}.cmd`), `@"${process.execPath}" "%~dp0fake-agent.cjs" %*\r\n`);
    } else {
      const p = join(dir, name);
      writeFileSync(p, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
      chmodSync(p, 0o755);
    }
  }
  return dir;
}

/** Create fake executables (`claude`, `codex`, …) in `dir`; returns `dir`. Windows: `.cmd` shims like npm's. */
export function fakeBin(dir: string, names: string[]): string {
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "fake-cli.cjs");
  copyFileSync(FIXTURE, script);
  for (const name of names) {
    if (process.platform === "win32") {
      writeFileSync(join(dir, `${name}.cmd`), `@"${process.execPath}" "%~dp0fake-cli.cjs" %*\r\n`);
    } else {
      const p = join(dir, name);
      writeFileSync(p, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
      chmodSync(p, 0o755);
    }
  }
  return dir;
}

/** Minimal environment for spawned test processes: system vars plus a controlled PATH. */
export function testEnv(path: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep = ["SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "PATHEXT", "WINDIR"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, PATH: path, ...extra };
}
