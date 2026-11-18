# devflow

Role-separated, multi-model development workflow with deterministic gates. Plans are written in [OpenSpec](https://github.com/Fission-AI/OpenSpec) change format; stages run through official model CLIs (`claude -p`, `codex exec`) on your own subscriptions.

Status: early. The core state machine, CLI and runners exist; gates, stage prompts with the OpenSpec adapter, the Claude Code / Codex plugins and the MCP server are next. Design: [docs/SPEC.md](docs/SPEC.md).

## Build

```bash
npm install
npm test        # builds with tsc and runs node:test
```

Requires Node 22+.

## Usage

```bash
devflow init [--runners mixed|claude|codex]     # create .devflow/config.json (+ .gitignore); detects installed CLIs
devflow start feat-x "Add export" --tracker GF-12   # tier defaults to medium
devflow next feat-x                            # next stage, role and attempt as JSON (read-only)
devflow complete feat-x explore ok             # record a stage outcome; the only way state advances
devflow approve feat-x                         # human plan approval (medium/complex)
devflow approve feat-x --resume                # resume a task waiting for a human
devflow tier feat-x small                      # human tier change (any direction)
devflow escalate feat-x --reason "gates failed twice"   # one tier up, reason recorded
devflow status [feat-x] [--json]
devflow exec-role verify --prompt-file p.md --task feat-x --expect .devflow/runs/feat-x/verdict.md
devflow exec-role implement --prompt-file p.md --write "src/**" --allow-bash "npm test"
devflow doctor [--probe] [--json]                # CLIs, versions, login; --probe makes one tiny call per runner/model
```

Stages: `explore → design → (approval) → implement → gates → verify` for medium/complex, `implement → gates` for small. Outcomes: `ok|fail` for explore, design, implement, gates; `pass|rework|human` for verify.

Exit codes: `0` ok, `1` domain error (with `--json`, stderr carries `{"error":{"reason","message"}}`), `2` usage error.

Run state lives in `.devflow/runs/<id>/state.json` and is git-ignored via `.devflow/.gitignore`.

## Runners

A role is a runner plus a model: `claude` (`claude -p`, Claude subscription), `codex` (`codex exec`, ChatGPT subscription) or `command` (any agent CLI from a template with `{model}`, `{prompt_file}`, `{cwd}`).

- The prompt goes on stdin, which is then closed (`codex exec` otherwise waits forever on a non-terminal stdin).
- The child gets an allowlisted environment only: system variables plus `runners.env.pass`. Session tokens and unrelated secrets in your shell do not reach the model. Vendor API keys are dropped so the CLI uses your subscription, unless `runners.<runner>.use_api_key` is true.
- Write scope: `claude` runs are `enforced` by a devflow PreToolUse hook injected with `--settings` (your own Claude allow rules cannot bypass it); `codex` runs are `sandbox` (read-only without `--write`, otherwise workspace-write); `command` runs are `advisory`.
- Expected outputs must be new or changed, non-empty files inside the project; logs go to `.devflow/runs/<task>/logs/` or `.devflow/logs/`, are created exclusively and have tokens redacted.
