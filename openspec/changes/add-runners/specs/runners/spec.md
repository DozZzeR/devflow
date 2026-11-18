## Purpose

Defines how devflow launches a model CLI to perform one role: how the prompt is delivered, what the role may write, how outputs, timeouts and logs are handled, how CLIs are launched on Windows, which credentials devflow never touches, and how installed runners are diagnosed.

## ADDED Requirements

### Requirement: Runner selection

The system SHALL run a role with the runner and model configured for it (`claude`, `codex` or `command`). For `command`, the configured template SHALL be expanded with `{model}`, `{prompt_file}` and `{cwd}`; any other placeholder MUST be rejected before launch.

#### Scenario: Codex role

- **WHEN** `roles.verify` is `{ "runner": "codex", "model": "m1" }` and the user runs `devflow exec-role verify --prompt-file p.md`
- **THEN** devflow launches `codex exec` with model `m1` in the project root

#### Scenario: Unknown placeholder

- **WHEN** a `command` role template contains `{secret}`
- **THEN** `exec-role` exits non-zero with reason `invalid_template` and launches nothing

### Requirement: Prompt on stdin, stdin always closed

The system SHALL deliver the prompt on the child's standard input and close it, and MUST NOT pass prompt text as a command-line argument. A runner MUST NOT wait for interactive input.

#### Scenario: CLI that reads stdin to EOF

- **WHEN** the runner launches a CLI that reads all of stdin before answering
- **THEN** the CLI receives the full prompt, sees end of input, and the run completes

### Requirement: Write scope

Each run SHALL receive a write scope (zero or more path globs relative to the project root) and an optional list of allowed shell commands. A run with an empty write scope is read-only and MUST NOT be given shell commands; such a combination MUST be rejected with reason `invalid_scope`.

#### Scenario: Shell in a read-only run

- **WHEN** `exec-role` is called with an empty write scope and `--allow-bash "npm test"`
- **THEN** it exits non-zero with reason `invalid_scope` and launches nothing

### Requirement: Write-scope enforcement mode

The result SHALL state how the scope was applied: `enforced` (devflow blocks, before execution, every write outside the scope and every shell command not allowed, regardless of the user's own CLI permission settings), `sandbox` (the CLI sandbox limits writes to its workspace and temporary locations; globs not enforced) or `advisory` (nothing enforced). A runner MUST NOT report `enforced` unless that blocking was active for the run.

#### Scenario: Claude scoped writes

- **WHEN** a `claude` role runs with write scope `src/**` and the user's own Claude settings allow all edits
- **THEN** an edit to `README.md` is blocked, an edit to `src/a.ts` is allowed, and the result reports `enforced`

#### Scenario: Codex read-only

- **WHEN** a `codex` role runs with an empty write scope
- **THEN** it is launched with a read-only sandbox and the result reports `sandbox`

### Requirement: Expected outputs

The system SHALL check, after the CLI exits, that every expected output is a regular, non-empty file inside the project root that was created or modified after the run started. Outputs failing any of these checks MUST be listed in the result and make the run unsuccessful even if the CLI exited with code 0.

#### Scenario: Missing output

- **WHEN** a run expects `.devflow/runs/t1/verdict.json` and the CLI exits 0 without creating it
- **THEN** the result has `ok: false` and `missingOutputs` contains that path

#### Scenario: Stale output

- **WHEN** `verdict.json` exists from an earlier run and the CLI exits 0 without rewriting it
- **THEN** the result has `ok: false` and lists the path as stale

### Requirement: Timeout

The system SHALL stop a run that exceeds its timeout (default 30 minutes, overridable per run), terminate the whole process tree, and report `timedOut: true`.

#### Scenario: Hanging CLI

- **WHEN** the CLI does not exit within a 2-second timeout
- **THEN** the process tree is terminated, the result has `timedOut: true` and `ok: false`

### Requirement: Run result and logs

Each run SHALL write the CLI's combined output to a new log file (`.devflow/runs/<task>/logs/<role>-<n>.log` when `--task` is given, otherwise `.devflow/logs/<role>-<timestamp>.log`) and print a JSON result with: runner, model, exit code, duration, `timedOut`, `missingOutputs`, write-scope mode, authentication source, log path and `ok`.

#### Scenario: Successful run

- **WHEN** the CLI exits 0 and all expected outputs are fresh
- **THEN** `exec-role` prints a JSON result with `ok: true`, exits 0, and the log file contains the CLI output

### Requirement: Log safety

Task ids used for log paths MUST pass the same validation as task creation. The log path MUST resolve inside the project's `.devflow/` directory after following links, and the file MUST be created exclusively (never appended to or overwritten). Values that look like credentials (API keys, bearer tokens) MUST be redacted in logs.

#### Scenario: Escaping task id

- **WHEN** `exec-role` is called with `--task ../x`
- **THEN** it exits non-zero with reason `invalid_id` and creates no file

#### Scenario: Secret in output

- **WHEN** the CLI prints `Authorization: Bearer abc123...`
- **THEN** the log contains the line with the token replaced by `[REDACTED]`

### Requirement: Windows launch

On Windows the system SHALL launch CLIs installed as `.cmd` or `.bat` shims through `cmd.exe` with quoting that survives `/s` quote stripping (the whole command line wrapped in an extra pair of quotes) and with delayed expansion disabled, without placing prompt text on the command line. It MUST refuse to launch when the resolved path or any argument contains characters `cmd.exe` would interpret (`&|<>^%!"` and line breaks). Paths with spaces MUST work.

#### Scenario: npm-installed CLI

- **WHEN** `codex` resolves to `codex.cmd` on Windows
- **THEN** the run starts and receives the prompt on stdin

#### Scenario: Shim path with spaces

- **WHEN** the shim lives in `C:\Program Files\x\codex.cmd`
- **THEN** the run starts normally

### Requirement: Credentials boundary

The system MUST NOT read, copy, store or transmit the CLIs' credentials or session tokens, and MUST NOT launch `claude` with options that disable its own sign-in (such as `--bare`). Authentication is entirely the CLI's own.

#### Scenario: Subscription login

- **WHEN** a user is signed in to `claude` or `codex` with a subscription
- **THEN** runs use that sign-in through the unmodified CLI and devflow's files contain no token

### Requirement: Subscription preference

By default the system SHALL remove API-key variables (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` for `claude`; `OPENAI_API_KEY` for `codex`) from the child environment so the CLI's subscription sign-in is used; `runners.<runner>.use_api_key: true` keeps them. The result SHALL state the source left available (`subscription` or `api_key`).

#### Scenario: API key present in the shell

- **WHEN** `ANTHROPIC_API_KEY` is set and `runners.claude.use_api_key` is not true
- **THEN** the `claude` child process does not receive `ANTHROPIC_API_KEY` and the result reports `subscription`

### Requirement: Diagnostics

`devflow doctor` SHALL report, for `claude` and `codex`, whether the CLI is on PATH, its version and its login status, and which configured roles depend on a missing CLI. `devflow doctor --probe` SHALL additionally make one minimal real call for every distinct (runner, model) pair used by the configuration, and report each pair with success and duration.

#### Scenario: Codex-only machine

- **WHEN** `codex` is installed and `claude` is not, and the config assigns `design` to `claude`
- **THEN** `doctor` reports `claude` missing and lists `design` as affected

#### Scenario: Probe covers every model

- **WHEN** the config uses `codex` with models `a` and `b`
- **THEN** `doctor --probe` reports one result for `codex/a` and one for `codex/b`
