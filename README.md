# devflow

Role-separated, multi-model development workflow with deterministic gates. Plans are written in [OpenSpec](https://github.com/Fission-AI/OpenSpec) change format; stages run through official model CLIs (`claude -p`, `codex exec`) on your own subscriptions.

Status: early. The core state machine and CLI exist; runners, gates, the OpenSpec adapter, the Claude Code plugin and the MCP server are next. Design: [docs/SPEC.md](docs/SPEC.md).

## Build

```bash
npm install
npm test        # builds with tsc and runs node:test
```

Requires Node 22+.

## Usage

```bash
devflow init                                   # create .devflow/config.json and .devflow/.gitignore
devflow start feat-x "Add export" --tracker GF-12   # tier defaults to medium
devflow next feat-x                            # next stage, role and attempt as JSON (read-only)
devflow complete feat-x explore ok             # record a stage outcome; the only way state advances
devflow approve feat-x                         # human plan approval (medium/complex)
devflow approve feat-x --resume                # resume a task waiting for a human
devflow tier feat-x small                      # human tier change (any direction)
devflow escalate feat-x --reason "gates failed twice"   # one tier up, reason recorded
devflow status [feat-x] [--json]
```

Stages: `explore → design → (approval) → implement → gates → verify` for medium/complex, `implement → gates` for small. Outcomes: `ok|fail` for explore, design, implement, gates; `pass|rework|human` for verify.

Exit codes: `0` ok, `1` domain error (with `--json`, stderr carries `{"error":{"reason","message"}}`), `2` usage error.

Run state lives in `.devflow/runs/<id>/state.json` and is git-ignored via `.devflow/.gitignore`.
