# devflow

Role-separated, multi-model development workflow with deterministic gates. Plans are written in [OpenSpec](https://github.com/Fission-AI/OpenSpec) change format; stages run through official model CLIs (`claude -p`, `codex exec`) on your own subscriptions.

Status: early. The core state machine, CLI, runners, gates and the `devflow run` loop exist; the Claude Code / Codex plugins and the MCP server are next. Design: [docs/SPEC.md](docs/SPEC.md).

## Build

```bash
npm install
npm test        # builds with tsc and runs node:test
```

Requires Node 22+.

## Usage

```bash
devflow init [--runners mixed|claude|codex]     # create .devflow/config.json (+ .gitignore); detects installed CLIs
devflow start feat-x "Add export" --tracker GF-12 --zone "src/**" --zone "test/**"
                                               # tier defaults to medium; records git HEAD as the task base
devflow next feat-x                            # next stage, role and attempt as JSON (read-only)
devflow complete feat-x explore ok             # record a stage outcome; gates ok by hand needs --override "<reason>"
devflow approve feat-x                         # human plan approval (medium/complex)
devflow approve feat-x --resume                # resume a task waiting for a human
devflow tier feat-x small                      # human tier change (any direction)
devflow escalate feat-x --reason "gates failed twice"   # one tier up, reason recorded
devflow status [feat-x] [--json]
devflow exec-role verify --prompt-file p.md --task feat-x --expect .devflow/runs/feat-x/verdict.md
devflow exec-role implement --prompt-file p.md --write "src/**" --allow-bash "npm test"
devflow doctor [--probe] [--json]                # CLIs, versions, login; --probe makes one tiny call per runner/model
devflow zone feat-x --from-design design.md      # zone from a "## Impact zone" section
devflow base feat-x main                         # set the base commit explicitly
devflow gate feat-x [zone|tests|rollback|all]    # all: records the gates stage when it is next
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

## Gates

Gates check a task's changes against its base commit, with no model involved. Each ends as `pass`, `fail` (the change is wrong) or `blocked` (the check could not run: no git, no base, setup or baseline failure, timeout).

- **zone**: every changed, added, deleted or untracked file since the base matches the task zone. `.devflow/config.json` counts; only `.devflow/runs/` and `.devflow/logs/` are ignored.
- **tests**: `test.command` passes in the working tree.
- **rollback**: in a temporary git worktree at the base, the suite passes; with only the changed test files (`test.paths`) it fails; with the whole change it passes again. Tests that pass without the production change fail the gate as `tests_check_nothing`. Your working tree is never touched.

Settings: `test.setup` (run in the worktree before the baseline and again if `test.setup_inputs` files changed, e.g. `npm ci`), `test.red_exit_codes` (e.g. `[1]` for pytest, so other codes become `blocked`), `test.timeout_seconds`. The test command runs in your shell with your environment: these are your own tests and no model sees that environment.

Repeated gate failures or a zone violation escalate the task by one tier (complex goes to a human); `blocked` goes to a human without escalation.

## Running a task

```bash
devflow start add-muldiv "Add mul and div; div throws on zero"   # medium by default
devflow run add-muldiv            # explore -> design, stops for plan approval
devflow approve add-muldiv        # re-checks the plan, binds it (digest) and sets the zone from design.md
devflow approve add-muldiv --reject "Spec delta must be a real file"   # or send the plan back with feedback
devflow run add-muldiv            # implement -> gates -> verify -> DONE (or back to implement on REWORK)
devflow run add-muldiv --once     # one stage only
devflow run add-muldiv --detach   # background; then:
devflow log add-muldiv --follow
```

- The plan is an OpenSpec change folder `openspec/changes/<id>/` (proposal, design with `## Impact zone` and `## Test plan`, tasks, spec deltas), with or without OpenSpec installed. If the `openspec` CLI is available it validates the plan (`openspec.cli`: `auto` | `on` | `off`).
- Each stage gets only its inputs; prompts are built in and can be replaced per project in `.devflow/prompts/<stage>.md`. The exact prompt of every run is saved next to its log.
- Verify runs in a disposable worktree (base + change) without `design.md`, exploration notes or devflow state; its edits are discarded. A second round looks only at high-severity findings and regressions.
- Evidence is bound to content: changing the plan after approval needs a new approval; changing code after the gates sends the task back to the gates (three such returns go to a human).
- `complete gates ok` and `complete verify pass` by hand need `--override "<reason>"`.

