# TODO

A running list of items Claude and I track between sessions. Remove each item when it is complete and verified. Remove the entire “Monitored runs” section after several consecutive runs uncover no new bugs.

## Monitored runs (priority)

Run devflow on several real tasks and watch the subagents (roles using `claude -p` / `codex exec`) closely. Track their errors and the quality of their results. The 2026-11-18 runs showed that quality depends heavily on the environment and CLI security settings.

- [ ] Run at least 3 real tasks (at least one medium and one small), including a project without OpenSpec and a project using OpenSpec.
- [ ] For each run, record the task, roles and models, duration, tokens, verdicts, and problems in the log below.
- [ ] Check what the role **actually saw**. Could it read the repo and run commands? In the codex sandbox, “blocked by policy” means the result is empty and the check is inconclusive. Check which environment the role received.
- [ ] Check that the role's output has substance, with a verdict containing file:line references and a concrete plan. Treat an empty or generic reply as an environment bug. It cannot qualify as “PASS”.
- [ ] Compare the same role on `claude` and `codex` for quality and cost, then refine the model presets.
- [ ] Run on a machine or profile **without Claude** (codex only), then run the reverse setup.
- [ ] Observe how subscription limits behave over several consecutive runs.

### Run log

| Date | Task | Roles/models | Result | Findings |
|---|---|---|---|---|
| 2026-11-18 | sandbox-calc `fix-sub` (small) | sonnet | DONE, 20 s | No findings. The gates returned pass, and rollback confirmed a failing test. |
| 2026-11-18 | sandbox-calc `add-muldiv` (medium), design | haiku → opus | design ok → rejection | Prompt bug. Outputs listed 3 files. opus put the spec in design.md and skipped the separate file. The built-in check missed this → fixed, and `approve --reject` was added. |
| 2026-11-18 | Same task, revision | opus | fail → ok | The “all files must be fresh” rule broke revisions (opus correctly kept valid files) → revisions now require a plan change and allow unchanged files. |
| 2026-11-18 | Same task, implement → verify | sonnet → codex | REWORK (low only) → PASS, 3.4 min, verify ~16–18 thousand tokens | verify returned REWORK for low findings alone and flagged the missing design.md → the prompt now limits REWORK to high/medium findings and says design.md is intentionally absent. |
| 2026-11-18 | verify `add-stage-run`, round 1 (3.4 min) | verify | REWORK, 11 | The gates could certify a version that changed during the run. The verify copy shared .git. A CLI launch failure threw an exception. |
| 2026-11-18 | verify `add-stage-run`, round 2 (4.2 min, high only) | verify | REWORK | 1 finding accepted, low-effort fixes made, and the rest deferred. |
| 2026-11-18 | Plugins on sandbox-calc | Claude Code (sonnet), Codex | ok | Claude's MCP tools worked with `--plugin-dir`. The Codex MCP server in the plugin directory found the project via `projectDir`, but `codex exec` blocks MCP calls without permission → read-only tools are allowed in the plugin's `.mcp.json`. |
| 2026-11-18 | verify `add-runners` (codex gpt-6.2-sol) | verify | HUMAN | `--ignore-user-config` dropped trust and the Windows sandbox settings, so codex could not read the repo → default false. |
| 2026-11-18 | verify `add-runners`, round 1 | verify | REWORK, 10 | A timeout failed to kill the process tree inside the codex sandbox (the test reported success after 60 s). The hook was fail-open. Keys passed through env.pass. |
| 2026-11-18 | verify `add-runners`, round 2 | verify | REWORK | The remaining work requires more extensive hardening. See “Deferred”. |
| 2026-11-18 | Plan review for `add-gates` (codex, via `exec-role`) | verify | REWORK, 7 | Manual `complete gates ok` bypassed checks. Any error counted as a failure. setup ran only on the base. All of `.devflow/` was excluded. |
| 2026-11-18 | Gates on devflow itself (`add-gates`) | — | pass ×3, 95 s | rollback: npm ci, baseline 75 → tests-only failed (TS compilation error, valid TDD failure) → full run 98. The working tree was untouched. |
| 2026-11-18 | verify `add-gates`, round 1 (5.2 min) | verify | REWORK, 10 | The test command came from the working config, which the role could replace. Writes reached the worktree via a symlink. Exceptions occurred in place of blocked. In the codex sandbox, 2 tests fail because of taskkill. |
| 2026-11-18 | verify `add-gates`, round 2 (3.8 min) | verify | REWORK | More extensive hardening is needed. Low-effort fixes were made. The rest is in “Deferred from add-gates”. |
| 2026-11-18 | `verify-calibration` (medium) using devflow on itself | haiku → opus → sonnet → codex | REWORK (1 high, 1 low) → HUMAN | claude $1.10 at list price + codex 63 thousand tokens. Gates took 4.3 min and failed the plugin bundle freshness check (missing generation step). implement-2 hit a 429 subscription limit and consumed an attempt → HUMAN. High finding: YAML parsing of `context: \| # comment`. |
| 2026-11-18 | Same task without devflow (one Opus session, branch `baseline/verify-calibration`) | opus | 149 pass, 4.5 min | $0.79 at list price. It parses the YAML cases from the high finding correctly. It reads context from the working tree, so a task can weaken its own threat model (the devflow plan addressed this). |
| 2026-11-18 | `verify-calibration`, final changes (revision 2) | opus → codex sol (implement and verify) | false PASS from sonnet → revision 2 → REWORK (high) → PASS, DONE | Task totals: claude ≈ $2.7 at list price (almost all from opus design + the first sonnet implement run), codex ≈ 347 thousand tokens. sonnet-verify missed a high finding that codex found. codex implement correctly stopped at a plan contradiction. Other findings included a verdict that never reached implement, a lost round verdict, BLOCKED, resetting attempts for a new plan, and a global codex AGENTS.md pointing outside the sandbox. |
| 2026-11-18 | `add-generate-step` (medium → complex) | codex luna → opus → codex sol (implement, verify) | REWORK → PLAN CONFLICT → revision 2 → REWORK (1 high) → automatic escalation, plan rewritten → PASS, DONE | Models and gates took 108 min (plan 7, runs 38+31+13+20), or 157 min including approval waits. claude $2.57 at list price (opus only, 3 plan versions), codex 549 thousand tokens. PLAN CONFLICT triggered automatically. The gates failed once on a flaky Windows test (EPERM during temp cleanup). |

## Known environment pitfalls

- `codex exec` waits indefinitely with non-terminal stdin → always close stdin.
- `codex exec --ignore-user-config` loses project trust and Windows sandbox settings.
- `claude --bare` skips OAuth → subscription access is disabled.
- Child processes inherit the entire session environment (`MEMPALACE_TOKEN` was observed) → use an allowlist only.
- The ChatGPT account lacks `gpt-5.5`. `fable` requires usage credits.
- `taskkill` can fail inside the codex sandbox → use bounded teardown and `killFailed`.

## Deferred from the independent review of `add-runners`

- [ ] Claude's `enforced` mode relies on the hook. Disabling all hooks removes that protection → the zone gate provides the guarantee (next change).
- [ ] Dangling symlinks in the hook target path and linked parent directories of expected outputs.
- [ ] Masking short secrets (<8 characters) and unrecognized `doctor` output.
- [ ] Relative executable paths in the `command` template resolve from the devflow cwd.
- [ ] Standalone log names with a numeric suffix.
- [ ] Use a Job Object in place of `taskkill` on Windows and traverse directories by handle.

## Deferred from `add-gates`

- [ ] Rollback treats the entire run as failing. A compilation error or runner crash looks the same as a failed assert. Add a check before testing (per-file rollback or parsing the runner report).
- [ ] The zone gates do not see role writes to paths ignored by git (`node_modules/`, etc.).
- [ ] Add the escalation trigger “diff extends beyond the files from triage” and use two runners for verify on complex.
- [ ] Bind the verify verdict to the diff hash (SPEC §7).
- [ ] Verify `add-gates`, round 2. Check for links in source paths and the project prefix when copying into a worktree. Check trust in `COMSPEC` and the test command environment (currently inherited in full, with the command taken from the base config). Protect task state files from linked directories. Test a timeout in the tests-only phase.

## Deferred from `add-stage-run`

- [ ] Background run locking needs atomic metadata writes and serialized stale lock handling (currently `wx` + a pid check).
- [ ] The Claude hook command on Windows inserts paths into a shell string. Use a shell-free entry point or escape paths for the shell.
- [ ] Links in plan files during design validation and plan fingerprinting.
- [ ] The tests/zone gates run against the live tree. The before-and-after snapshot check misses edits made and reverted during the run. Run tests in a snapshot too (like rollback).
- [ ] Verify on codex can run any command in its copy (within the codex sandbox). The copy contains the rest of the project and excludes `.git`.

## Deferred from `add-plugins-mcp`

- [ ] Role writes (`roles set` / `propose --apply`) have no shared project lock. Concurrent edits can overwrite each other.
- [ ] Background devflow processes inherit the server/CLI environment (the models already use an allowlist).
- [ ] In MCP, `devflow_run` returns runId and its own status. Other background tasks return jobId. Use one interface.
- [ ] The check that the project is outside the plugin directory is lexical (without realpath/aliases).
- [ ] `roles propose --probe` accepts a model on successful exit without checking that it replied “OK”.
- [ ] Verify round 2. Forged task and log records via symlinks in .devflow. Individual gates and role probes run without a lock (state writes are protected by the updatedAt check).
- [ ] Check plugin installation from the GitHub marketplace after merge (currently verified via `--plugin-dir` and the Codex MCP config).

## From the `verify-calibration` run

- [x] Generation step (`build.generate` / `build.outputs`) — `add-generate-step`.
- [ ] A subscription limit error (429, `usage_limit_reached`) should pause the task until the limit resets, leave the attempt count unchanged, and avoid HUMAN.
- [ ] `devflow usage <id>` should total tokens and costs from role logs (claude JSON, codex “tokens used”).
- [x] **Critical bug:** on REWORK, implement did not receive the verify verdict or the failed gate analysis (codex implement spent 35 thousand tokens and fixed nothing). Fixed in e5cf9ca.
- [x] Implement stopped with “the plan is incorrect”, but devflow ran gates and verify on the same code.
      A `PLAN CONFLICT: ...` line in the implement response now rejects the plan (revision +1, reason and
      verdict go to design). A repeated conflict leads to HUMAN (`plan_conflicts_limit`).
- [x] Sonnet in the verify role put its verdict in the response and omitted the file → HUMAN. The verdict now comes from the claude JSON response when the file is missing. The regular log is unsuitable because codex echoes the prompt.
- [ ] The zone gates attribute human edits during a task to the role (here, `roles set` and TODO) → false outside_zone and automatic escalation to complex. Snapshot dirty paths when implement starts or add an explicit `devflow status` warning.
- [x] Verdict failed to reach implement (e5cf9ca). PLAN CONFLICT and verdict from the claude response (7efacdc).
      Lost verdict from a failed round (ccafd7e). BLOCKED and attempt reset for a new plan (a1b2601).
- [ ] Have `devflow init` create `.agents/instructions.md` (an index of guidance sets: SOLID for all code, DDD for the backend, FDD for the frontend) and link to it from AGENTS.md/CLAUDE.md. Roles read the index. External instruction paths are unavailable in the codex sandbox, so the guidance lives in the project (owner decision 2026-11-18).
- [ ] Observation: verify on sonnet is weaker than codex (it missed a high finding in YAML parsing). For now all roles except design use codex (owner decision 2026-11-18). Verify independence relies solely on its context.
- [ ] Automatic escalation after repeated REWORK rewrites the plan without increasing the revision number. The owner decided that a new plan version must get a new number.
- [ ] Flaky test `simultaneous starts: exactly one wins` hits EPERM when deleting a temp directory on Windows (the background process still holds the directory). Add cleanup retries in `test/helpers`. This caused gate failures.
- [ ] Verify rates minor config edge cases (`././plugins/**`) as high even though the owner writes the config, placing them outside the threat model. Limit high findings to acceptance criteria and threats in the context.
- [ ] Balance vendors dynamically. When the user says “less Claude / more Codex” (or the reverse), devflow switches to a preset role scheme (`roles scheme claude-light|codex-light|balanced`) while following “verify ≠ implement”. Later, switch automatically based on the remaining allowance (429).
- [ ] When `language` ≠ `en`, explicitly require the prompt to keep structural headings (`## Impact zone`,
      `## Test plan`, `### Requirement:`, `#### Scenario:`) and SHALL/MUST/WHEN/THEN in English (a colleague uses OpenSpec 1.15.0 this way, with artifacts in Russian and keywords in English).
- [ ] OpenSpec compatibility. At runtime devflow calls only `validate <id> --strict`. We verified that
      1.15.0 validates our specs and change (10/10). Pin the CLI version in the user's project
      (`openspec.cli`) and use the same version in CI with `openspec validate --all --strict --no-interactive`.

## Process

- [ ] Verify rule (adopted 2026-11-18). Limit to 2 rounds. The second round checks only high findings and regressions from the first round. Add this to the verify prompt along with `devflow run`.

- [ ] Avoid using `python -c "..."` with backticks in bash for edits. On
      2026-11-18 this caused command substitution (including an unintended `npm ci`
      in the repo). Use a script file or Edit.

- [ ] After `openspec archive`, automatically run `openspec validate --specs --strict`.
      Archive twice left the live specs with warnings (placeholder Purpose and overly long requirements).
      Add this to the devflow gates.
- [ ] Include `## Purpose` in the delta for new capabilities from the start. Keep requirements < 500 characters.

## Roadmap (next changes)

- [x] Gates: zone, rollback-check, tests (+ automatic escalation per SPEC §4.4) — `add-gates`.
- [x] Stage prompts + `devflow run` + OpenSpec adapter — `add-stage-run`.
- [x] Claude Code and Codex plugins from a single source of skills — `add-plugins-mcp`.
- [x] MCP server (`devflow_run` in the background, status, log) — `add-plugins-mcp`.
- [x] Delegate plan approval to a model on explicit user request — `add-plugins-mcp`.
- [ ] Require stronger confirmation for approval via MCP (outside chat, using a terminal code or client elicitation).
- [ ] Roles and models. Use the strongest available model for `design_complex` (Fable only when credits are available). Rebalance roles before work begins on a project or on user request. The model invoking devflow can propose the assignments.

## Owner decisions (2026-11-18)

- A human approves the plan by default.
- Use REWORK only for high/medium findings. Report low findings as notes with PASS.
- Default to `en` for artifacts to save tokens unless the project chooses another language.
- Take up deferred hardening only when critical to operation. Otherwise, wait for a real task.
- Keep the existing `MEMPALACE_TOKEN`. codex already has access to it.
- TaskFrame is the tracker. The plan to run OpenProject on hetzner is closed.

## Later

- [ ] Decide how to present devflow publicly. Choose a license (leaning toward making it open) and decide whether to present it alongside OpenSpec (with a mention) or separately. Decide once everything works reliably.
