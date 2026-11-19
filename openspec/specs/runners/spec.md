# runners Specification

## Purpose
Defines how devflow launches a model CLI to perform one role: how the prompt is delivered, what the role may write, how outputs, timeouts and logs are handled, how CLIs are launched on Windows, which credentials devflow never touches, and how installed runners are diagnosed.

## Requirements

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

#### Scenario: Allowed shell command is not sandboxed

- **WHEN** a `claude` run allows `npm test` and that command writes outside the scope
- **THEN** the run still reports `enforced` for editing tools, and the write is left for the zone gate to detect

#### Scenario: Codex read-only

- **WHEN** a `codex` role runs with an empty write scope
- **THEN** it is launched with a read-only sandbox and the result reports `sandbox`

### Requirement: Expected outputs

The system SHALL check, after the CLI exits, that every expected output is a regular, non-empty file inside the project root that was created during the run or whose content differs from a snapshot (size and SHA-256) taken before launch. Outputs failing any of these checks MUST be listed in the result and make the run unsuccessful even if the CLI exited with code 0.

#### Scenario: Missing output

- **WHEN** a run expects `.devflow/runs/t1/verdict.json` and the CLI exits 0 without creating it
- **THEN** the result has `ok: false` and `missingOutputs` contains that path

#### Scenario: Stale output

- **WHEN** `verdict.json` exists from an earlier run and the CLI exits 0 without rewriting it
- **THEN** the result has `ok: false` and lists the path as stale

### Requirement: Timeout

The system SHALL stop a run that exceeds its timeout (default 30 minutes, overridable per run), terminate the whole process tree, and report `timedOut: true`. If the tree kill cannot be confirmed, the run SHALL still end within a bounded teardown period and report `killFailed: true`.

#### Scenario: Hanging CLI

- **WHEN** the CLI does not exit within a 2-second timeout
- **THEN** the process tree is terminated within seconds (not when the CLI would have exited on its own), the result has `timedOut: true` and `ok: false`

### Requirement: Run result and logs

Each run SHALL write the CLI's combined output to a new log file (`.devflow/runs/<task>/logs/<role>-<n>.log` when `--task` is given, otherwise `.devflow/logs/<role>-<timestamp>.log`) and print a JSON result with: runner, model, exit code, duration, `timedOut`, `missingOutputs`, write-scope mode, `apiKeyEnv`, log path and `ok`.

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

On Windows the system SHALL launch CLIs installed as `.cmd` or `.bat` shims through `cmd.exe` with every argument and the path double-quoted, the whole command line wrapped in an extra pair of quotes to survive `/s`, and delayed expansion disabled, without placing prompt text on the command line. It MUST refuse to launch when the path or any argument contains characters that stay special inside quotes (`"%!^` and line breaks) or `&|<>`. Paths with spaces or parentheses MUST work.

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

### Requirement: Child environment allowlist

The system SHALL build the child environment from an allowlist, not by inheriting the parent's: OS and runtime variables the CLIs need (path, home, profile, temp, locale, system root and similar), the CLI's own config-location variables, and names listed in `runners.env.pass`. Every other parent variable MUST NOT reach the child.

#### Scenario: Unrelated secret in the parent shell

- **WHEN** `MEMPALACE_TOKEN` is set in the parent environment and not listed in `runners.env.pass`
- **THEN** the child process environment does not contain `MEMPALACE_TOKEN`

#### Scenario: Explicit pass-through

- **WHEN** `runners.env.pass` contains `HTTPS_PROXY`
- **THEN** the child receives `HTTPS_PROXY` from the parent

### Requirement: Subscription preference

API-key variables (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` for `claude`; `OPENAI_API_KEY` for `codex`) SHALL NOT be passed by default, so the CLI's subscription sign-in is used; `runners.<runner>.use_api_key: true` passes them even if absent from `runners.env.pass`. The result SHALL state `apiKeyEnv: stripped | kept`; it MUST NOT claim which source the CLI finally used, since CLI settings (for example an API-key helper) can still select one.

#### Scenario: API key present in the shell

- **WHEN** `ANTHROPIC_API_KEY` is set and `runners.claude.use_api_key` is not true
- **THEN** the `claude` child process does not receive `ANTHROPIC_API_KEY` and the result reports `apiKeyEnv: stripped`

### Requirement: Diagnostics

`devflow doctor` SHALL report, for `claude` and `codex`, whether the CLI is on PATH, its version and its login status, and which configured roles depend on a missing CLI. `devflow doctor --probe` SHALL additionally make one minimal read-only real call for every distinct (`claude` or `codex`, model) pair used by the configuration; `command` roles are reported as not probed, since devflow cannot make an arbitrary CLI read-only, and report each pair with success and duration.

#### Scenario: Codex-only machine

- **WHEN** `codex` is installed and `claude` is not, and the config assigns `design` to `claude`
- **THEN** `doctor` reports `claude` missing and lists `design` as affected

#### Scenario: Probe covers every model

- **WHEN** the config uses `codex` with models `a` and `b`
- **THEN** `doctor --probe` reports one result for `codex/a` and one for `codex/b`

### Requirement: Usage-limit detection

After a `claude` or `codex` run with a numeric exit code, the system SHALL set `usageLimit` and `ok: false` when the run ended on a subscription or rate limit. For `claude` (any numeric exit), the last JSON object line has `api_error_status` 429 or `api_error` `usage_limit_reached`. For `codex`, the exit is non-zero and one of the last 50 log lines contains `error` with `usage limit` or a standalone `429`. A null exit MUST NOT count for any runner.

#### Scenario: Claude usage limit

- **WHEN** a `claude` run exits 0 and its log ends with `{"type":"result","is_error":true,"api_error":"usage_limit_reached","result":"5-hour limit reached ∙ resets 5pm"}`
- **THEN** the result has `ok: false` and `usageLimit` with `runner: "claude"` and `reset: "5pm"`

#### Scenario: Claude rate limit without reset

- **WHEN** a `claude` run exits with a number and its last JSON line has `api_error_status: 429` and its text names no reset
- **THEN** the result has `usageLimit` without `reset`

#### Scenario: Killed Claude run is not a limit

- **WHEN** a `claude` run prints a final JSON object with `api_error: "usage_limit_reached"` and is then killed or times out, so its exit code is null
- **THEN** the result has no `usageLimit`

#### Scenario: Codex usage limit

- **WHEN** a `codex` run exits 1 and its last log line is `ERROR: You've hit your usage limit. Try again at 5:00 PM.`
- **THEN** the result has `usageLimit` with `runner: "codex"` and `reset: "5:00 PM"`

#### Scenario: Timed-out Codex run is not a limit

- **WHEN** a `codex` run prints `ERROR: 429` and then times out or is killed, so its exit code is null
- **THEN** the result has no `usageLimit`

#### Scenario: Echoed prompt is not a limit

- **WHEN** a `codex` run exits 1 because of an ordinary error, and the words `usage limit` appear only in the echoed prompt more than 50 lines before the end of the log
- **THEN** the result has no `usageLimit`

#### Scenario: Successful run mentioning 429

- **WHEN** a `codex` run exits 0 and its answer contains `error 429`
- **THEN** the result has no `usageLimit`

#### Scenario: Command runner is never classified

- **WHEN** a `command` runner exits 1 and prints `ERROR: You've hit your usage limit.`
- **THEN** the result has no `usageLimit`

### Requirement: Reset text

The reset SHALL be the text after the first `resets`, `try again at` or `try again in`, up to the line end or `|`, ending at the first word that ends with a period. A dotted abbreviation such as `p.m.` keeps its periods; other such words lose the final one. The text is trimmed and capped at 100 characters. For Codex, the search starts at the first matching line of the error block. A Claude `|<epoch seconds>` suffix SHALL become an ISO UTC time. No reset MUST be invented.

#### Scenario: Epoch reset

- **WHEN** the Claude result text is `Claude AI usage limit reached|1763571600`
- **THEN** `usageLimit.reset` is `2025-11-19T17:00:00.000Z`

#### Scenario: Punctuated reset

- **WHEN** a `codex` run exits 1 with `ERROR: You've hit your usage limit. Try again at 5 p.m.`
- **THEN** `usageLimit.reset` is `5 p.m.`

#### Scenario: Reset on a later line of the error

- **WHEN** a `codex` run exits 1 with `ERROR: You've hit your usage limit.` followed by the line `Upgrade to Pro or try again at 5:00 PM.`
- **THEN** `usageLimit.reset` is `5:00 PM`

#### Scenario: Several matching lines in one error block

- **WHEN** a `codex` run exits 1 with `ERROR: You've hit your usage limit. Try again at 5:00 PM.` directly followed by `ERROR: HTTP 429`
- **THEN** `usageLimit.reset` is `5:00 PM`

#### Scenario: Decimal in the reset

- **WHEN** the limit text says `try again in 2.5 hours.`
- **THEN** `usageLimit.reset` is `2.5 hours`
