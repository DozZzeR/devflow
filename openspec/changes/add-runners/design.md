# Design

## Context

Core lifecycle, config and CLI exist (`openspec/specs/task-lifecycle`, `project-config`). Findings from probing the real CLIs on the author's Windows machine (2026-11-18):

- `claude` 2.1.322 is a native `claude.exe`. Relevant flags: `-p`, `--model`, `--output-format json`, `--permission-mode dontAsk`, `--allowedTools` / `--disallowedTools` (support path patterns such as `Edit(src/**)`), `--json-schema`, `--no-session-persistence`, `--settings`. `--bare` skips OAuth, so it would break subscription use.
- `codex` 0.170.0 is `codex.cmd` → `node …/@openai/codex/bin/codex.js`. Relevant flags: `exec`, `-m`, `-s read-only|workspace-write`, `-C`, `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config`, `-o <file>`, `--output-schema`, `--json`. With non-TTY stdin it prints "Reading additional input from stdin..." and waits for EOF. Default model on a ChatGPT login: `gpt-6.2-sol`; the model cache also lists `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`.
- A trivial `codex exec` used ~5.5k tokens, mostly loading the user's plugins and skills.

## Goals / Non-Goals

**Goals:**
- One `Runner` interface, three implementations, one process helper that owns spawning, stdin, timeouts, logging.
- Tests that never call a model: fake `claude`/`codex` executables placed first on PATH.

**Non-Goals:**
- Stage prompts, `devflow run`, OpenSpec adapter, gates (next change).
- Choosing models per tier beyond role config.

## Decisions

1. **Prompt via stdin, always closed.** Solves the Codex hang and keeps prompts off the command line (length limits, quoting, `cmd.exe` injection). Claude `-p` and Codex `exec` both read the prompt from stdin when no prompt argument is given.

2. **Process helper (`src/proc.ts`).** `resolveCommand(name)` searches PATH with PATHEXT on Windows. If the hit is `.cmd`/`.bat`, launch `cmd.exe /d /s /c "<path>" <args>` with `windowsVerbatimArguments`, after rejecting any argument containing `&|<>^%"` or newlines. Arguments are only flags, model names, paths and globs, so the check never blocks legitimate use. Alternative: parse the shim and call `node <script>` directly. Rejected: depends on npm's shim format.

3. **Timeout kills the tree.** Windows: `taskkill /PID <pid> /T /F`; elsewhere: spawn detached and `process.kill(-pid)`. Default 30 minutes; `--timeout` overrides.

4. **Claude write scope = enforced.** `--permission-mode dontAsk` plus `--allowedTools Read Grep Glob` and, per write glob, `Edit(<glob>)` and `Write(<glob>)`; per allowed shell command, `Bash(<cmd>)`. Everything else is refused without a prompt. Session not persisted (`--no-session-persistence`). Output `--output-format json` goes to the log.

5. **Codex write scope = sandbox.** Empty scope → `-s read-only`; otherwise `-s workspace-write`. Globs cannot be enforced by Codex; the zone gate (next change) is the guarantee. Flags: `--skip-git-repo-check --ephemeral -C <root>`. `--ignore-user-config` is used by default (`runners.codex.ignore_user_config`, default true) to avoid loading user plugins into every run; task 3.3 verifies it keeps the ChatGPT login working, otherwise the default flips to false.

6. **Command runner = advisory.** Template expanded with `{model}`, `{prompt_file}`, `{cwd}`; the prompt is also written to a temp file for CLIs that want a path. Template split on whitespace; quoted segments supported; no shell.

7. **Init detection.** `resolveCommand` for `claude` and `codex`. Codex-only defaults: explore `gpt-5.6-luna`, design `gpt-6.2-sol`, implement `gpt-5.6-terra`, verify `gpt-5.5`, small `gpt-5.6-terra`. Claude-only: explore `haiku`, design `opus`, implement `sonnet`, verify `opus`, small `sonnet`. Mixed: as today, with verify on Codex `gpt-6.2-sol`. These are starting points; `doctor --probe` confirms they exist on the account.

8. **Doctor.** Version via `--version`; login via `codex login status` and `claude auth status` (if the subcommand is absent, report `unknown` rather than fail). `--probe` runs `exec-role`-style minimal calls with a 120 s timeout and stdin closed.

## Impact zone

- `src/proc.ts`
- `src/runners/**`
- `src/config.ts`
- `src/cli.ts`
- `test/**`
- `README.md`
- `docs/SPEC.md`
- `openspec/changes/add-runners/tasks.md`

## Test plan

- `test/proc.test.ts`: PATH/PATHEXT resolution; `.cmd` launch through `cmd.exe` on Windows (skipped elsewhere); metacharacter refusal; stdin delivered and closed (fake CLI echoes stdin length after EOF); timeout kills a child that spawned a grandchild.
- `test/runners.test.ts`: argument building for each runner and write scope (pure functions, exact arrays); missing expected output → `ok: false`; `invalid_template`; log file written; result JSON shape.
- `test/cli-runners.test.ts`: `exec-role` and `doctor` against fake `claude`/`codex` scripts on PATH; codex-only / claude-only / override `init` scenarios from `specs/project-config`.
- Manual (task 4.x, recorded in the task): one real `codex` and one real `claude` run via `doctor --probe` on the author's machine.

## Risks / Trade-offs

- [Codex cannot enforce globs] → reported as `sandbox`; zone gate catches violations after the run.
- [Model names drift] → defaults are data in config; `doctor --probe` reveals unknown models early.
- [`claude auth status` may not exist in all versions] → report `unknown`, never fail doctor on it.
- [`--ignore-user-config` might drop settings the user relies on] → configurable; verified in task 3.3.
