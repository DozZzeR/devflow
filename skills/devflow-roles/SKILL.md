---
name: devflow-roles
description: Review and rebalance which model does which devflow role (explore, design, design_complex, review, implement, small, verify). Use before starting work on a project with devflow, when the user asks about models or costs, or when a model is unavailable.
---

# devflow roles

Each devflow role runs on a runner (`claude`, `codex`, or a `command` template) and a model. The layout lives in `.devflow/config.json`.

## Review the layout

1. `devflow_roles` — show the current layout to the user as a short table.
2. `devflow_roles_propose { probe: true }` — starts a background job that calls each installed model once and proposes a layout (strongest model on `design_complex` and `review`, verify on a different model than implement, preferably the other vendor). Poll `devflow_job_status`, then read the proposal from `devflow_log`.
3. Explain the proposal and its trade-offs in one or two lines per change (quality vs cost vs subscription limits). You may suggest your own adjustments.
4. Apply only what the user agrees to: `devflow_roles_propose { apply: true }` for the whole proposal, or `devflow_roles_set { role, runner, model }` per role.

## Notes

- Fable needs extra usage credits; it is never a default. Suggest it for `design_complex` only when the user says credits are available.
- The verifier should not be the implementer's model; with a single available model devflow warns `verify_not_independent`.
- A `command` runner needs a template with `{model}`, `{prompt_file}`, `{cwd}`; such roles are not probed.
