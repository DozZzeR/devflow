# Proposal

## Why

The core can say which stage and role come next, but nothing can execute a role yet. Runners are the step that turns devflow from a bookkeeper into a tool: they launch the official model CLIs (`claude -p`, `codex exec`, or any agent CLI) on the user's own subscriptions, with the role's model and write scope. They also have to survive two traps found while testing: `codex exec` hangs forever when stdin is not a terminal, and npm-installed CLIs on Windows are `.cmd` shims that cannot be spawned directly. Users may have only one of the two CLIs (some prefer Codex), so the configuration must adapt to what is installed.

## What Changes

- Runner layer with three runners: `claude`, `codex`, `command` (templated agent CLI).
- Every run: prompt delivered on stdin and stdin closed; output logged to a file; expected output files checked; timeout with process-tree kill; a JSON result.
- Write scope per run: enforced for `claude` (tool permissions), sandbox-level for `codex`, advisory for `command`; the result states which.
- Windows launcher for `.cmd`/`.bat` shims that never passes prompt text through the shell.
- `devflow exec-role <role> --prompt-file <f> [--write <glob>]... [--expect <path>]... [--allow-bash <cmd>]... [--timeout <s>] [--task <id>]`: low-level command to run one role once. Stage prompts and `devflow run` come with the gates/OpenSpec-adapter change.
- `devflow doctor [--probe]`: which CLIs are installed, versions, login status; `--probe` makes one tiny read-only real call per distinct runner/model pair in the config.
- `devflow init` detects installed CLIs and writes roles accordingly (both, Codex-only, Claude-only). Default Codex model updated from `gpt-5-codex` to the current default.

## Capabilities

### New Capabilities

- `runners`: how devflow launches a model CLI for a role: prompt delivery, write scope, outputs, timeouts, logging, Windows launch, credentials boundary, diagnostics.

### Modified Capabilities

- `project-config`: initialization now chooses role runners from the CLIs found on the machine.

## Impact

- New `src/runners/*`, `src/proc.ts`; new CLI commands `exec-role`, `doctor`; `init` behaviour changes for machines without `claude` or without `codex`.
- No new runtime dependencies.
- Real-CLI checks (`doctor --probe`, a live `exec-role`) consume a little of the user's subscription quota; automated tests use fake CLIs and never call models.
