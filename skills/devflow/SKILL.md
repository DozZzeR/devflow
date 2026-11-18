---
name: devflow
description: Run a development task through devflow's role-separated pipeline (explore, design, human plan approval, implement, gates, independent verify). Use when the user asks to do a task "through devflow", to start, continue, check or steer a devflow task, or mentions .devflow/ in the project.
---

# devflow

devflow drives a task through stages, each done by its own model role, and checks the result with deterministic gates. You are the user's interface to it: you start and watch tasks, show results, and relay the user's decisions. You do not do the stages' work yourself.

Use the `devflow_*` MCP tools. Always pass `projectDir` = the project's working directory.

## Typical flow

1. `devflow_status` — see existing tasks. If the project has no `.devflow/`, tell the user to run `devflow init` (or `node <plugin>/bin/devflow.mjs init`) in the project.
2. `devflow_start` with a short kebab-case `id`, the user's task as `description`, and `tier` (`small` for a one-file fix, `medium` by default, `complex` for risky work).
3. `devflow_run` — starts the stages in the background and returns at once. Then poll `devflow_run_status` every 20–60 seconds and show progress from `devflow_log` (a few lines, not the whole log).
4. When the task stops at `awaiting_plan_approval`: show the user the plan from `openspec/changes/<id>/` (proposal, spec deltas, design's impact zone and test plan, tasks) and the plan revision from `devflow_status`. Then wait. Approval is the user's decision — see the `devflow-approval` skill.
5. After approval run again. The task ends `DONE`, or stops at `HUMAN` with a reason: report the reason and the relevant log lines, and ask the user what to do.

## Rules

- Never edit files in `openspec/changes/<id>/` or source files of a running task yourself; devflow's roles own them.
- Never call `devflow_approve`, `devflow_reject` or `devflow_delegate_approval` unless the user told you to in this conversation.
- `blocked` gate results mean the check could not run (environment), not that the code is wrong; show the reason.
- Long work is always a background job; never wait in a single call.
