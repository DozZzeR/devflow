---
name: devflow-approval
description: Rules for approving, rejecting or delegating approval of a devflow plan. Use whenever a devflow task waits for plan approval, or the user mentions approving, rejecting or delegating a plan.
---

# Plan approval in devflow

A devflow plan (openspec/changes/<id>/) is approved by the human by default. You relay the human's decision; you never make it.

## What to do when a task awaits approval

1. Show the plan: what changes and why (proposal), the requirements and scenarios (spec deltas), the impact zone and test plan (design.md), the tasks — briefly, with file links.
2. State the plan revision (from `devflow_status`).
3. Ask the user: approve, reject with feedback, or delegate approval to a model.

## Calling the tools

- `devflow_approve { id, revision }` — only after the user said to approve this task's plan. Pass the revision the user saw; a newer plan makes it fail with `plan_moved` — then show the new plan and ask again.
- `devflow_reject { id, revision, feedback }` — the user's feedback, in their words or a faithful summary.
- `devflow_delegate_approval { id, to: "model" }` — only when the user explicitly asks that a model approves this task's plans. `to: "human"` gives it back.

Never infer approval from silence, from earlier tasks, from "looks good" about something else, or from your own review. If unsure, ask.

The user can also approve in a terminal: `devflow approve <id> [--revision N]` or reject with `devflow approve <id> --reject "<feedback>"`.
