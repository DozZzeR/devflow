## Why

When verify asks for rework twice on a `medium` task, or gates fail repeatedly, or a zone gate fails, devflow escalates the task to `complex` and sends it back to design. The task already has an approved plan, so this redesign is a plan revision. Devflow does not treat it as one: the escalation leaves `planRevision` unchanged, and `src/stages.ts` recognises a revision only from a plan rejection. The design stage then runs the first-plan freshness check, sees the unchanged spec delta of the approved plan, and fails with `stale_delta`. The designer also never sees why the plan failed: the escalation reason, the current plan files and the latest verify findings are missing from its context.

## What Changes

- An automatic escalation from `medium` to `complex` starts a new plan revision in the same lifecycle transition. It increments `planRevision` by exactly one, clears the old approval digest and gates snapshot, and records the new revision next to the trigger in its `escalate` history entry.
- The design stage treats a run after such an escalation as a plan revision, as it does after a rejection:
  - the binding revision request names the escalation trigger and the tier change;
  - the context includes every current plan file and the evidence for the escalation (the latest verify verdict for rework, or the failed gate result for a gate trigger);
  - files may be kept, so there is no pre-run freshness comparison and no required fresh outputs;
  - the full `checkDesign()` content check still applies.
- A design retry after a failed design run stays on the same revision. The bump happens only in the escalation transition and never in the design stage.
- A first plan keeps the freshness check, in which every spec delta must be freshly written, and keeps its own test.
- Manual `devflow escalate` and `devflow tier` keep their current behaviour.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `task-lifecycle`: automatic `medium` → `complex` escalation starts a new plan revision and needs a fresh approval.
- `stage-execution`: the design-stage contract separates first plans (all files fresh) from plan revisions (current files may be kept). Escalation-driven revisions get the same context and checks as rejections.

## Impact

- Code: `src/lifecycle.ts` (the `autoEscalate` helper in `transition()`) and `src/stages.ts` (revision detection and context in the `design` branch).
- Tests: `test/lifecycle.test.ts` (unit tests for the revision bump) and `test/run.test.ts` (end-to-end tests with the fake agent, with no model cost).
- Developer guide: update the escalation and retry guidance in `docs/DEVELOPMENT.md` alongside the routing JSDoc.
- State format: no schema change. The revision is stored in the existing optional `results` field of the `escalate` history entry (`revision <N>`).
- Unchanged: `src/artifacts.ts` (`checkDesign()`), `src/prompts.ts`, the CLI surface and MCP tools.
- Follow-up, not in scope: a manual `medium` → `complex` escalation of an approved plan could use the same revision path later.
