# devflow — specification v0.1

Status: **draft for review**. Date: 2026-11-17.

## 1. Purpose

devflow runs a development task through several roles, each with its own model and permissions. It addresses three weaknesses of a prompt-based pipeline that relies on a single model following instructions in one session:

1. **Context accumulates.** Each role starts with fresh context and receives only its own inputs.
2. **Rules lack enforcement.** Code checks the edit zone, stage order, and attempt limits.
3. **The author also reviews the work.** Verify uses a model that neither planned nor wrote the code. The rollback script detects tests that verify nothing.

What devflow is **not**:

- a task tracker (TaskFrame, Jira, and OpenProject can be connected later through adapters);
- a replacement for OpenSpec;
- an agent loop of its own. The models’ official CLI tools edit files and run commands.

## 2. Principles

- **Independence.** devflow has no dependency on OpenSpec and is not an OpenSpec plugin. It works the same way in projects without OpenSpec.
- **One source of truth for the plan: the OpenSpec format.** devflow always writes the plan as an OpenSpec change directory (`openspec/changes/<id>/`), whether or not the project uses OpenSpec. OpenSpec treats the change as native. On a machine without devflow, the standard `/opsx:apply` can implement it.
- **Extend the existing format.** The zone and test plan go in sections within the native files. Only machine state and derived state are stored separately.
- **Subscription access.** Roles run through the official CLI tools: `claude -p` (Claude subscription) and `codex exec` (ChatGPT subscription). Roles use subscriptions in place of API keys. devflow makes no direct LLM calls.
- **Deterministic orchestrator.** The state machine decides which stage comes next.
- **Minimal dependencies.** Runtime: Node 22+, `@modelcontextprotocol/sdk`, `zod`.

## 3. Architecture

```
          ┌──────────────────── inputs ────────────────────┐
          │ CLI `devflow`   Claude Code plugin   MCP server │
          └────────────────────────┬───────────────────────┘
                                   ▼
   ┌──────────────────────── core ───────────────────────┐
   │ stage state machine · role config · gates           │
   │ (check-zone, rollback-check, validate, limits)      │
   └──────┬─────────────────────┬────────────────────────┘
          ▼                     ▼
   model runners          change store
   claude -p              OpenSpec format (always)
   codex exec             + OpenSpec CLI, if installed
                          + .devflow/ (machine state)
                                ▼
                       tracker adapters (later)
```

The core has no knowledge of entry points, runners, or trackers. They connect through interfaces (`Runner`, `ChangeStore`, `Tracker`).

## 4. Stages and task tiers

### 4.1 Stages

| # | Stage | Role (default) | Input | Output |
|---|---|---|---|---|
| 1 | explore | Haiku | Task statement, `openspec/specs/`, code (read-only) | `.devflow/runs/<id>/facts.md` |
| 2 | design | Opus | Task, facts.md, specs | Change directory: proposal, design (with zone and test plan), tasks, spec deltas |
| — | **gate: plan** | Human + code | Change directory | `openspec validate` OK, zone parsed, **human approved the plan** |
| 3 | implement | Sonnet | Change directory, code | Code and test changes, completed tasks.md checkboxes |
| — | **gate: code** | Code | diff | check-zone OK, rollback-check OK, test command passes |
| 4 | verify | codex | Criteria (scenarios), diff, gate results. **Without** design reasoning and implement logs | Verdict PASS / REWORK / HUMAN |
| 5 | done | Human | PASS verdict | Commit/PR at the human's discretion, then archive |

REWORK returns the task to implement with verify findings. A gate: code failure also returns it to implement. `limits.implement` caps implementation attempts (default 3). When attempts run out, the task moves to `HUMAN`.

### 4.2 Tiers

| Tier | Stages |
|---|---|
| small | implement → gate: code → done. OpenSpec recommends skipping the change directory for fixes that preserve behavior, and this tier follows that recommendation. Set the zone at startup (`--zone`). Without it, the zone gate is skipped with a warning |
| medium | All stages |
| complex | All stages. By default, design uses the strongest model (`roles.design_complex`). Verify can use two runners |

devflow chooses the default tier (see 4.4). A human can set it explicitly with `--tier` or change it at any time.

### 4.4 Tier selection and escalation

**Initial tier.** If `--tier` is absent, a short triage runs first (`explore` role, low-cost model). It writes `.devflow/runs/<id>/triage.json` using a fixed schema that covers expected files, effects on behavior and specs, migrations, and public APIs. A rule in code maps the result to a tier without relying on the model's judgment. For example, a behavior change or more than N files → medium. Migrations, core changes, or a public API → complex. Otherwise, small.

A single model handles **small** (`roles.small`, default Sonnet). The zone, rollback, and tests gates are always required because they are free to run.

**Escalation is automatic** because it only adds checks and cost. All triggers are deterministic.

| Trigger | Action |
|---|---|
| The code gate failed `limits.escalate_after` times in a row (default 2) | Tier +1 |
| implement attempted to write outside the zone | Tier +1 |
| The diff extends beyond the files expected in triage | small → medium |
| verify returned REWORK twice | medium → complex |
| `limits.implement` was exhausted on complex | HUMAN |

Escalation leaves the working tree intact (`add-gates` established that resetting to the base is destructive). On small → medium, the task starts from explore. Both explore and design see the changes already made. On medium → complex, `design_complex` revises the plan.

Implemented in `add-gates`: escalation after repeated gate failures (`gates_failed_repeatedly`), a zone violation (`zone_violation`), or a second REWORK on medium (`rework_repeated`). On complex, the task moves to HUMAN. Environment failures (`blocked`) do not trigger escalation. The trigger “diff extends beyond the files from triage” and verify with two runners are still pending.

Only a human can **lower** the tier. Each escalation and its reason are recorded in `state.json` and shown in `status`.

### 4.3 States

`NEW → EXPLORED → DESIGNED → PLAN_APPROVED → IMPLEMENTED → GATES_PASSED → VERIFIED → DONE`.
There are also `REWORK` (returns to implement) and `HUMAN` (waits for a decision). Only the core defines transitions. `devflow next <id>` returns the next stage and its inputs. The core rejects a stage if it differs from `next`.

## 5. Roles, models, and runners

Role = runner + model + permissions + role prompt.

### 5.1 Runners

| Runner | Command | Subscription | Permissions |
|---|---|---|---|
| `claude` | `claude -p --model <m> --allowedTools <...> --output-format json` | Claude | Tool allowlist + project hooks (PreToolUse) |
| `codex` | `codex exec --model <m> --sandbox <read-only\|workspace-write>` | ChatGPT | codex sandbox |
| `command` | Command template from the config, for example `opencode run --model {model} --file {prompt_file}` | Any / your own | Limited to what the tool provides. devflow gates always apply |

**Local models** (Ollama, LM Studio) use an existing runner. Use `codex` with a local provider (`codex exec --oss` or `model_provider` in the codex config) or `command` with any agent CLI that supports a local model. A role needs an agent CLI to read files and edit code.

**devflow calls models directly, without going through an orchestrator model’s MCP tools.** (1) A model’s response stays out of the other model’s context. This avoids extra tokens and paraphrasing and preserves verify independence. (2) The workflow works the same from any client without configuring codex MCP for each one. (3) Code applies gates and limits without relying on a model’s decision to call codex. The model in Claude App or Claude Code only asks devflow to run the stage and displays the result.

Runner requirements (implemented in `add-runners`, with details in `openspec/specs/runners`):

- Send the prompt to stdin, then close stdin. Otherwise, `codex exec` with non-terminal stdin waits indefinitely;
- Build the child environment from an allowlist (system variables plus `runners.env.pass`). Session tokens and unrelated secrets do not reach the model. Remove vendor API keys to use the subscription (`runners.<runner>.use_api_key` restores them);
- Never start `claude` with `--bare`. This mode skips OAuth and disables subscription access;
- On Windows, run `.cmd` shims (`codex.cmd`) through `cmd.exe /d /v:off /s /c` with double quotes. Reject arguments containing `"%!^&|<>`;
- Check a role’s results on disk. Each expected output must be new or changed (hash before and after), nonempty, and inside the project;
- Write logs to `.devflow/runs/<id>/logs/<role>-<n>.log` (or `.devflow/logs/`). Create them exclusively and mask tokens.

### 5.2 Permissions by role

| Role | Read | Write |
|---|---|---|
| explore | Entire repo | Only `.devflow/runs/<id>/` |
| design | Entire repo | Only `openspec/changes/<id>/` and `.devflow/runs/<id>/` |
| implement | Entire repo | Only files in the zone + the change’s `tasks.md` |
| verify | Change directory (excluding design.md, see below), diff, tests | Only `.devflow/runs/<id>/verdict.json` |

For the `claude` runner, the PreToolUse hook (`devflow hook
pre-tool-use`) limits writes. devflow attaches it to each invocation via `--settings`. It checks the path against the current stage’s permissions. User allow rules cannot bypass it (verified in a live run on 2026-11-18). Plugin agents ignore `hooks` and `permissionMode` in frontmatter, so register the hook in the plugin’s `hooks/hooks.json` or in the project’s `.claude/settings.json`.

For verify, the prompt takes only the section of `design.md` titled `Test plan`. The author’s reasoning is deliberately withheld from verify.

### 5.3 Default models

```json
{
  "roles": {
    "explore":        { "runner": "claude", "model": "haiku" },
    "small":          { "runner": "claude", "model": "sonnet" },
    "design":         { "runner": "claude", "model": "opus" },
    "design_complex": { "runner": "claude", "model": "fable" },
    "implement":      { "runner": "claude", "model": "sonnet" },
    "verify":         { "runner": "codex",  "model": "gpt-5-codex" }
  }
}
```

Claude only: `verify` → `{ "runner": "claude", "model": "opus" }`.
Codex only: all roles use `codex`. One line per role.

## 6. OpenSpec compatibility

### 6.1 Directory layout

```
openspec/
  specs/<capability>/spec.md          # living specs (maintained by OpenSpec / archive)
  changes/<id>/
    proposal.md                       # native format
    design.md                         # native format + our sections
    tasks.md                          # native format
    specs/<capability>/spec.md        # deltas: ADDED/MODIFIED/REMOVED, scenarios
.devflow/
  config.json                         # project config (committed)
  .gitignore                          # created by `devflow init`, contains `runs/`
  runs/<id>/                          # machine state (not committed)
    state.json  facts.md  zone.json  verdict.json  logs/
```

### 6.2 Rules

1. The plan itself lives **only** in `openspec/changes/<id>/`.
2. devflow adds the `## Impact zone` and `## Test plan` sections to `design.md`. OpenSpec treats them as normal design text.
3. `## Impact zone` lists paths and glob patterns, one per line, in `- path` format. `zone.json` is **generated** from this section each time a gate runs. Do not edit it by hand. Test files from the test plan must also be in the zone.
4. Put the tracker task id (for example `GF-123`) on a line at the start of `proposal.md`.
5. Scenarios in spec deltas (`#### Scenario:` with WHEN/THEN) are the acceptance criteria for verify and the basis for the test plan.
6. If the `openspec` CLI is installed, gate: plan calls `openspec validate <id> --strict`. Otherwise, it uses the built-in minimal structure check.
7. Archive uses `openspec archive <id>` when the CLI is available. Otherwise, devflow performs a simplified delta merge and reports that it did so.
8. The default OpenSpec schema and `openspec/config.yaml` stay as they are in colleagues’ projects.

### 6.3 Compatibility guarantee

The devflow repo tests a generated fixture change against `openspec validate --strict` with a pinned OpenSpec version (devDependency). If the OpenSpec format changes, this test will fail first.

**Check during the build:** Confirm the current version’s exact `validate` requirements for proposal/tasks/deltas and check that extra sections in `design.md` produce no warnings.

## 7. Gates

| Gate | Check | Method |
|---|---|---|
| plan | Change structure, parsed zone, and human approval | `openspec validate` or the built-in check. `devflow approve <id>` records approval |
| zone | `git diff --name-only` relative to the task base ⊆ zone ∪ {the change’s tasks.md} | No model |
| rollback | New and changed tests fail without production changes and pass with them | See 7.1 |
| tests | The project test command passes | `config.test.command` |
| verify | Verdict is bound to the sha256 of the current diff | A stale verdict (the diff changed) is invalid |

### 7.1 rollback-check

1. Split the task diff into tests (`config.test.paths`) and production code (everything else in the zone).
2. In a temporary git worktree at the task base, apply **only** the test changes. Run the test command and expect the new tests to fail.
3. Apply the production changes and expect the tests to pass.
4. A test that passes without production changes is flagged as “verifies nothing” and fails the gate.

All operations run in a separate worktree, leaving the user’s working tree untouched.

### 7.2 Implementation status (`add-gates`, details in `openspec/specs/gates`)

zone, tests, and rollback are implemented (`devflow gate <id> [zone|tests|rollback|all]`). Each gate has three outcomes: `pass`, `fail` (the change is invalid), and `blocked` (the check could not run to completion because git or the base was missing, setup/baseline failed, the run timed out, or worktree removal failed). `blocked` sends the task to a human without escalating. Run `test.setup` (for example `npm ci`) in the worktree before the baseline. Run it again if the change touches dependency files. Future changes will implement the plan gate and bind verify to the diff hash.

Limitations: A failure counts at the level of the whole run. A compilation error due to unwritten code is a valid TDD failure and does not prove each test fails. The zone gate cannot see writes to paths ignored by git.

## 8. Entry points

### 8.1 CLI

Status (`add-stage-run`): `run [--once] [--detach]`, `log [--follow]`, and `approve --reject` are implemented. The plan is always in `openspec/changes/<id>/`, and verify runs in an isolated worktree. See `openspec/specs/stage-execution` and `change-artifacts` for how the plan is bound to its fingerprint at approve and evidence to a code snapshot. The README lists current commands.

```
devflow init                      # create .devflow/config.json, check the runners
devflow start <id> "<task>" [--tier small|medium|complex] [--tracker GF-123]
devflow next <id>                 # next stage and its inputs (JSON)
devflow run <id> [--stage x]      # run the next stage with its runner
devflow approve <id>              # approve the plan (gate: plan)
devflow gate <id> [zone|rollback|tests|all]
devflow status [<id>]
devflow archive <id>
devflow hook pre-tool-use         # called by the Claude Code hook
```

### 8.2 Claude Code plugin

- Commands `/devflow:start`, `/devflow:next`, `/devflow:status`, `/devflow:approve`.
- Hook `PreToolUse` → `devflow hook pre-tool-use`.
- The main session calls `devflow next` and starts the stage with `devflow run`. The `claude` runner starts as a separate process with the required model. Skipping built-in subagents ensures the permissions and model match the config.

**Open question:** Should roles using the `claude` runner run as subagents (`model:` in frontmatter) so they appear in the UI? Plugin agents have limited permissions (see 5.2). Decide after the prototype.

### 8.3 MCP server

Start with `node <path>/dist/mcp.js`. Do not use `npx`. Tools:

- `devflow_start`, `devflow_next`, `devflow_status`, `devflow_approve`;
- `devflow_run` starts the stage in the background and returns `run_id` **immediately**. MCP calls do not run for a long time;
- `devflow_run_status(run_id)`, `devflow_log(run_id, tail)`.

This lets devflow run from Claude desktop chat, OpenCode, and any other MCP client.

## 9. Project config `.devflow/config.json`

```json
{
  "roles": { "...": "see 5.3" },
  "limits": { "implement": 3, "verify": 2, "escalate_after": 2 },
  "test": {
    "command": "python manage.py test",
    "paths": ["**/tests/**", "**/test_*.py"]
  },
  "openspec": { "cli": "auto" },
  "logs": { "keep": 20 }
}
```

`zod` validates the configuration. Unknown fields cause an error.

The optional `test.focused` is a command template with exactly one `{files}` placeholder (and no other `{...}`). It is read from the base commit, like `build.generate`. When it is set, the implement, small and verify roles get it instead of the full `test.command`. The Claude hook allows only the template filled with one or more files separated by single spaces (at most 64). Each file is a relative path made of `[A-Za-z0-9_./-]`, has no `.` or `..` segment, does not start with `-`, and matches `test.paths`. Any other text is denied. Prompt placeholders: `{{focusedCommand}}`, `{{implementTests}}`, `{{verifyTests}}`. Verify does not rerun the full suite: the gate results are for the same snapshot (the hash is re-checked before PASS), and the verdict marks each piece of evidence as "confirmed by gates" or "checked additionally". The gates still run the full `test.command`.

## 10. Stack

TypeScript, Node 22+, build with `tsc` without a bundler, tests with `node:test`.
Runtime dependencies: `@modelcontextprotocol/sdk`, `zod`.
devDependency: `@fission-ai/openspec` (pinned version) for the compatibility test.

## 11. Implementation plan

| Step | Work | Done when |
|---|---|---|
| 1 | Core: config, state machine, `start/next/status/approve` | Unit tests cover transitions, including rejection of a stage that differs from next |
| 2 | Gates `zone`, `rollback`, `tests` | Tests run on a fixture git repo and cover the “test verifies nothing” case |
| 3 | ChangeStore in OpenSpec format + `Impact zone` parser + compatibility test with `openspec validate` | The fixture passes `--strict` |
| 4 | Runners `claude`, `codex` (Windows shims, logs, output file validation) | Both run manually using subscriptions |
| 5 | PreToolUse hook | A real `claude -p` run rejects an edit outside the zone |
| 6 | Claude Code plugin | It installs from the git marketplace into a second project |
| 7 | MCP server | A stage starts from Claude desktop chat |
| 8 | Pilot: 3–5 real tasks | Measure token use, limits, and the number of tests caught verifying nothing |

## 12. Risks and open questions

- **Subscription limits.** Roles share limits with normal work. Parallel runs reach those limits faster.
- **Subscription rules** ([Claude Code: Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)). devflow runs the **unmodified** `claude` binary. Each user signs in with **their own** subscription through the standard Anthropic sign-in flow. This is allowed. devflow never reads, stores, or transmits claude.ai tokens. The rules prohibit embedding Claude.ai sign-in in your application, running other people’s requests through your subscription (shared server, team CI), and reselling access. Pro/Max limits are intended for “normal individual use”. Unconfirmed third-party reports suggest headless `claude -p` may draw from a separate pool of limits. Check this in the pilot. For Codex/ChatGPT, check the equivalent OpenAI terms.
- **Codex through a local proxy.** The author’s codex MCP uses `127.0.0.1:3456`. Verify that `codex exec` can use the subscription without a proxy.
- **The OpenSpec format** changes (classic workflow and OPSX). Use a compatibility test and a pinned version.
- **Subagents versus separate processes** for the `claude` runner (see 8.2).
- **Cost.** The forecast for a medium task is the same cost as a single Opus session or up to 40% less, with better quality. Confirm in the pilot.
