# devflow

Role-separated, multi-model development workflow with deterministic gates. Plans are written in [OpenSpec](https://github.com/Fission-AI/OpenSpec) change format; stages run through official model CLIs (`claude -p`, `codex exec`) on your own subscriptions.

Status: early (0.1.0). CLI, runners, gates, the `devflow run` loop, an MCP server and Claude Code / Codex plugins exist. Design: [docs/SPEC.md](docs/SPEC.md).

## Revising one part of an OpenSpec plan

`devflow nodes <id>` (MCP: `devflow_nodes`) lists the stable checkbox IDs, text and completion state from the change's `tasks.md`. The designer decomposes work after exploration. Each node names a scenario, dependencies when relevant, and its test. The whole OpenSpec change remains the unit of approval and integration testing.

Use `devflow approve <id> --revision 3 --reject "Clarify the failure case" --node 2.1` to revise a single task. Design receives the full plan and writes one replacement in a temporary directory. Devflow inserts only that unchecked task and its indented details. Omit `--node` for a change to shared requirements, scope or dependencies across tasks. A task stopped at `plan_conflicts_limit` can use the same revision-checked rejection to return to design.

For numbered verify findings, a revised `tasks.md` may record a decision for each finding. IDs belong to a specific review round. Each fix names an existing checkbox. Deferred and dismissed findings carry the reason and use `-` for the node.

```markdown
## Review decisions (round 1)

- F1 | fix | 2.1 | Distinguish a timeout from a usage limit.
- F2 | defer | - | Display formatting belongs to a later change.
```

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

Settings: `test.setup` (run in the worktree before the baseline and again if `test.setup_inputs` files changed, e.g. `npm ci`), `test.red_exit_codes` (e.g. `[1]` for pytest, so other codes become `blocked`), `test.timeout_seconds`. The test command runs in your shell with your environment: these are your own tests and no model sees that environment. The optional `build.generate` command runs after a successful implement and in rollback and verify worktrees after changes are applied. `build.outputs` requires `build.generate` and extends an existing impact zone. Output globs may not start with `.devflow` after stripping leading `./` segments. A generate failure after implement sends the command's log tail to the next implement attempt.

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

## Install as a plugin

Requires Node 22+ on PATH (the plugin runs `node bin/devflow.mjs`, a single bundled file; no `npm install`).

**Claude Code**

```bash
claude plugin marketplace add DozZzeR/devflow
claude plugin install devflow@devflow
```

**Codex**

```bash
codex plugin marketplace add DozZzeR/devflow
```

Then enable `devflow` in `/plugins`. Codex starts MCP servers inside the plugin folder, so the assistant passes `projectDir` on every call (the `devflow` skill tells it to). Read-only tools run without a prompt; tools that start work or record a decision ask for confirmation.

Then, in a project: run `devflow init` once (or ask the assistant to), and ask it to do a task "through devflow".

## MCP tools

`devflow mcp` serves: `devflow_status`, `devflow_start`, `devflow_next`, `devflow_run` (background, returns a run id), `devflow_run_status`, `devflow_gate` (background job), `devflow_job_status`, `devflow_log`, `devflow_approve`, `devflow_reject`, `devflow_delegate_approval`, `devflow_roles`, `devflow_roles_propose`, `devflow_roles_set`. Every tool takes `projectDir`; without it the server uses `CLAUDE_PROJECT_DIR`, then its working directory.

**Approval stays yours.** `devflow_approve`, `devflow_reject` and `devflow_delegate_approval` record a human decision: the assistant may call them only on your explicit instruction, they must name the plan revision you saw, and you should not "always allow" them in your client's permission prompt.

## Roles and approval delegation

```bash
devflow roles                        # role -> runner/model table
devflow roles propose --probe        # call each installed model once and propose a layout
devflow roles propose --probe --apply
devflow roles set verify claude opus
devflow delegate-approval feat-x --to model   # a reviewer model approves or rejects plans for this task
devflow delegate-approval feat-x --to human   # give it back
```

Defaults never use Fable (it needs extra credits); `propose --probe` puts the strongest model that answers on `design_complex` and `review`, and a different model, preferably the other vendor, on `verify`. A delegated reviewer sees only a copy of the plan; if the plan changes while it works, its verdict is discarded; after three model rejections approval returns to you.

