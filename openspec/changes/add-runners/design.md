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

2. **Process helper (`src/proc.ts`).** `resolveCommand(name)` searches PATH with PATHEXT on Windows. If the hit is `.cmd`/`.bat`, launch `cmd.exe /d /v:off /s /c ""<path>" <arg> <arg>…"` with `windowsVerbatimArguments`: `/s` strips exactly the outer pair, so the extra pair protects a quoted path with spaces; `/v:off` disables `!` expansion. The resolved path and every argument are rejected if they contain `&|<>^%!"` or line breaks; arguments containing spaces are wrapped in quotes. Arguments are only flags, model names, paths and globs, so the check never blocks legitimate use. Alternative: parse the shim and call `node <script>` directly. Rejected: depends on npm's shim format. Child environment is built explicitly (see decision 9).

3. **Timeout kills the tree.** Windows: `taskkill /PID <pid> /T /F`; elsewhere: spawn detached and `process.kill(-pid)`. Default 30 minutes; `--timeout` overrides.

4. **Claude write scope = enforced by a devflow hook, not by allow rules.** Allow rules alone are not enough: `dontAsk` still honours the user's existing allow rules (review finding 1). devflow writes a per-run settings file (`.devflow/runs/<task>/logs/<role>-<n>.settings.json` or under `.devflow/logs/`) containing a `PreToolUse` hook that runs `node <devflow>/dist/src/cli.js hook pre-tool-use --scope-file <file>`, and passes it with `--settings`. The hook denies `Edit`/`Write`/`MultiEdit`/`NotebookEdit` whose target path, resolved against the project root, is outside the scope globs, denies any `Bash` command that is not exactly one of the allowed commands, and denies unknown write-capable tools. Hook decisions block regardless of allow rules. Additionally `--permission-mode dontAsk` and `--disallowedTools Bash` when no shell commands are allowed. Result mode is `enforced` only when the settings file was written and passed. Session not persisted (`--no-session-persistence`); `--output-format json` goes to the log. Task 3.4 confirms with a real `claude -p` run that a user-level allow-all rule does not bypass the hook.

5. **Codex write scope = sandbox.** Empty scope → `-s read-only`; otherwise `-s workspace-write`. `workspace-write` also permits temporary directories and any writable roots from the user's Codex config, so the mode is reported as `sandbox` and never as project-only; `--add-dir` is never passed, and `--ignore-user-config` (decision below) drops user-configured extra roots. Globs cannot be enforced by Codex; the zone gate (next change) is the guarantee. Flags: `--skip-git-repo-check --ephemeral -C <root>`. `--ignore-user-config` is used by default (`runners.codex.ignore_user_config`, default true) to avoid loading user plugins into every run; task 3.3 verifies it keeps the ChatGPT login working, otherwise the default flips to false.

6. **Command runner = advisory.** Template expanded with `{model}`, `{prompt_file}`, `{cwd}`; the prompt is also written to a temp file for CLIs that want a path. Template split on whitespace; quoted segments supported; no shell.

7. **Init detection.** `resolveCommand` for `claude` and `codex`. Codex-only defaults: explore `gpt-5.6-luna`, design `gpt-6.2-sol`, implement `gpt-5.6-terra`, verify `gpt-5.5`, small `gpt-5.6-terra`. Claude-only: explore `haiku`, design `opus`, implement `sonnet`, verify `opus`, small `sonnet`. Mixed: as today, with verify on Codex `gpt-6.2-sol`. These are starting points; `doctor --probe` confirms they exist on the account.

8. **Doctor.** Version via `--version`; login via `codex login status` and `claude auth status` (if the subcommand is absent, report `unknown` rather than fail). `--probe` runs one minimal read-only call per distinct (runner, model) pair in the config, sorted, 120 s timeout each, stdin closed, and reports each pair.

9. **Child environment and credentials.** The child env is a copy of the parent's minus `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` (claude) or `OPENAI_API_KEY` (codex) unless `runners.<r>.use_api_key` is true. The result reports `auth: subscription | api_key`. devflow never reads `~/.codex/auth.json` or Claude credential stores.

10. **Logs.** Task id validated with the existing `validateId`; the log directory is created, then `realpath` must stay inside `<root>/.devflow`; log files are opened with flag `wx`. Output passes through a redactor for `sk-…`, `sk-ant-…`, `Bearer …`, `Authorization:` values and `api[_-]?key=…` before it is written.

11. **Fresh outputs.** Before launch, devflow records the run start time. After exit, each expected path must resolve inside the project root, be a regular file (not a link to outside), be non-empty, and have `mtime >= start`. Otherwise it is reported as `missing` or `stale`.

12. **Argument parser.** `parseArgs` gains repeatable flags (`--write`, `--expect`, `--allow-bash`) collected into arrays; other flags stay single-valued.

## Impact zone

- `src/proc.ts`
- `src/runners/**`
- `src/config.ts`
- `src/store.ts`
- `src/cli.ts`
- `test/**`
- `README.md`
- `docs/SPEC.md`
- `openspec/changes/add-runners/tasks.md`

## Test plan

- `test/proc.test.ts`: PATH/PATHEXT resolution; `.cmd` launch through `cmd.exe` on Windows (skipped elsewhere) including a shim in a directory with spaces; metacharacter refusal in path and args (incl. `!`); stdin delivered and closed (fake CLI echoes stdin length after EOF); timeout kills a child that spawned a grandchild; API-key variables stripped / kept per setting.
- `test/runners.test.ts`: argument building for each runner and write scope (pure functions, exact arrays); `invalid_scope` for shell in read-only; missing and stale expected outputs → `ok: false`; `invalid_template`; result JSON shape.
- `test/hook.test.ts`: `hook pre-tool-use` decisions for in-scope / out-of-scope / `..` traversal / absolute paths / allowed and disallowed Bash / unknown write tools, fed with Claude's hook JSON on stdin.
- `test/logs.test.ts`: redaction patterns; exclusive creation; `--task ../x` rejected; log dir symlink/junction pointing outside rejected (skipped where links cannot be created).
- `test/cli-runners.test.ts`: `exec-role` and `doctor` against fake `claude`/`codex` scripts on PATH; repeated flags; codex-only / claude-only / no-CLI / override `init` scenarios; `.devflow/.gitignore` upgrade; `runners` config section accepted and unknown keys rejected.
- Manual (recorded in tasks 3.3 and 3.4): `doctor --probe` for real; a real `claude -p` run with a user allow-all rule proving the hook still blocks an out-of-scope edit.

## Risks / Trade-offs

- [Codex cannot enforce globs] → reported as `sandbox`; zone gate catches violations after the run.
- [Model names drift] → defaults are data in config; `doctor --probe` reveals unknown models early.
- [`claude auth status` may not exist in all versions] → report `unknown`, never fail doctor on it.
- [`--ignore-user-config` might drop settings the user relies on] → configurable; verified in task 3.3.
