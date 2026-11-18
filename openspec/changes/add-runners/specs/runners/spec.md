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

Each run SHALL receive a write scope (zero or more path globs relative to the project root) and an optional list of allowed shell commands. The result MUST state how the scope was applied: `enforced` (the CLI refuses writes outside it), `sandbox` (the CLI can only write inside the project, globs not enforced), or `advisory` (not enforced). With an empty write scope, `claude` and `codex` runs MUST be read-only.

#### Scenario: Claude scoped writes

- **WHEN** a `claude` role runs with write scope `src/**`
- **THEN** the run is launched so that edits outside `src/**` are refused without a prompt, and the result reports `enforced`

#### Scenario: Codex read-only

- **WHEN** a `codex` role runs with an empty write scope
- **THEN** it is launched with a read-only sandbox and the result reports `sandbox`

### Requirement: Expected outputs

The system SHALL check, after the CLI exits, that every expected output path exists and is non-empty. Missing outputs MUST be listed in the result and make the run unsuccessful even if the CLI exited with code 0.

#### Scenario: Missing output

- **WHEN** a run expects `.devflow/runs/t1/verdict.json` and the CLI exits 0 without creating it
- **THEN** the result has `ok: false` and `missingOutputs` contains that path

### Requirement: Timeout

The system SHALL stop a run that exceeds its timeout (default 30 minutes, overridable per run), terminate the whole process tree, and report `timedOut: true`.

#### Scenario: Hanging CLI

- **WHEN** the CLI does not exit within a 2-second timeout
- **THEN** the process tree is terminated, the result has `timedOut: true` and `ok: false`

### Requirement: Run result and logs

Each run SHALL write the CLI's combined output to a log file (`.devflow/runs/<task>/logs/<role>-<n>.log` when `--task` is given, otherwise `.devflow/logs/<role>-<timestamp>.log`) and print a JSON result with: runner, model, exit code, duration, `timedOut`, `missingOutputs`, write-scope mode, log path and `ok`.

#### Scenario: Successful run

- **WHEN** the CLI exits 0 and all expected outputs exist
- **THEN** `exec-role` prints a JSON result with `ok: true`, exits 0, and the log file contains the CLI output

### Requirement: Windows launch

On Windows the system SHALL launch CLIs installed as `.cmd` or `.bat` shims through `cmd.exe` without placing prompt text on the command line, and MUST refuse to launch when any argument contains characters that `cmd.exe` would interpret (`&|<>^%"` and line breaks).

#### Scenario: npm-installed CLI

- **WHEN** `codex` resolves to `codex.cmd` on Windows
- **THEN** the run starts and receives the prompt on stdin

### Requirement: Credentials boundary

The system MUST NOT read, copy, store or transmit the CLIs' credentials or session tokens, and MUST NOT launch `claude` with options that disable its own sign-in (such as `--bare`). Authentication is entirely the CLI's own.

#### Scenario: Subscription login

- **WHEN** a user is signed in to `claude` or `codex` with a subscription
- **THEN** runs use that sign-in through the unmodified CLI and devflow's files contain no token

### Requirement: Diagnostics

`devflow doctor` SHALL report, for `claude` and `codex`, whether the CLI is on PATH, its version and its login status, and which configured roles depend on a missing CLI. `devflow doctor --probe` SHALL additionally make one minimal real call per runner used by the configuration and report success and duration.

#### Scenario: Codex-only machine

- **WHEN** `codex` is installed and `claude` is not, and the config assigns `design` to `claude`
- **THEN** `doctor` reports `claude` missing and lists `design` as affected
