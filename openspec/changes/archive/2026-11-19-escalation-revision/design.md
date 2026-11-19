## Context

`transition()` in `src/lifecycle.ts` sends a task back to design in three ways:

- `reject`, which increments `planRevision`, clears `planDigest` and `gatesSnapshot`, resets attempts and records a `reject` entry;
- `plan_conflict`, which follows the same new-revision path;
- automatic escalation through the local `autoEscalate(reason)` helper. It calls `applyTierChange(t, to)` and records `{ kind: "escalate", from, to, reason }`, but it does not touch `planRevision`, `planDigest` or `gatesSnapshot`.

Automatic escalation has three triggers: `rework_repeated` after the second medium `rework`, `gates_failed_repeatedly`, and `zone_violation`. Each trigger fires only after implement has run, so a `medium` task that escalates always has an approved plan. `medium` → `complex` routes to `EXPLORED`, which runs design next. `small` → `medium` restarts at `NEW`/explore, and there is no plan yet.

The `design` branch of `src/stages.ts` finds `latest = history.findLast(reject | tier | escalate)` and sets `request` only when `latest.kind === "reject"`. A revision is detected only when a rejection reason exists. In revision mode:

- the context adds the binding request, the current plan files (`changeContext`) and `reworkFeedback(root, task, true)`;
- `required` is `[]`, so runModel does not demand fresh outputs;
- `checkDesign()` is called without `before`, so retained deltas are allowed;
- an unchanged plan is reported as `plan_files_unchanged`, not as a failure.

Otherwise `checkDesign(..., before)` runs the first-plan freshness check, which returns `stale_delta` after an escalation.

## Decisions

1. **The bump lives in the escalation transition.** In `autoEscalate`, after `applyTierChange`, when `from === "medium"` and `to === "complex"` (the only automatic escalation that routes to design with an existing plan):
   - set `t.planRevision = (t.planRevision ?? 1) + 1`;
   - `delete t.planDigest` and `delete t.gatesSnapshot`;
   - push the `escalate` entry with the extra field `results: "revision <N>"`.

   Attempts are already reset by `autoEscalate`. The bump is part of one atomic transition, so a design retry, a pause or a re-run of the design stage cannot repeat it. This mirrors the reject behaviour. The `complex` → `HUMAN` and `small` → `medium` paths are unchanged.
2. **The revision is recorded in the existing `results` field.** The history schema already has an optional `results` string. Other entries use it for attribution, and `to` already holds the target tier. `revision <N>` therefore needs no schema version change. It also marks the entry as revision-starting, so the design stage does not need to infer this from tiers.
3. **Revision detection in `stages.ts` is keyed on the recorded marker.** `latest` is computed as today. Then:
   - `request` is the latest entry when it is a `reject`, or an `escalate` entry whose `results` matches `/^revision \d+$/`;
   - for an escalation, the binding text is built from the entry, for example: `Automatic escalation medium → complex (rework_repeated): the approved plan did not converge. Revise it so the latest review findings are resolved.`;
   - `revision` becomes `request !== undefined` instead of depending on the length of a rejection reason;
   - the current plan files and `reworkFeedback(root, task, true)` are added for every revision. For `rework_repeated`, include the latest verify verdict. For a gate trigger, include the failed gate and its reported evidence. A gate can escalate before the first verification, so a verdict is optional on that path.

   Manual `escalate` and `tier` entries have no marker, so they keep the first-plan path. `request.node` exists only on rejections, so `reviseNode` routing is unchanged.
4. **Freshness and content checks.** A revision passes no `before` to `checkDesign()` and has `required = []`. The existing path is reused unchanged. `checkDesign()` still requires the three root files, the impact zone, the test plan and a usable spec delta (`missing_spec_delta`), so skipping freshness does not allow an empty plan. The first-plan path, with `before` and fresh required files, is not touched, and its test in `test/prompts.test.ts` ("design checks: files, zone, test plan, stale deltas, validation modes") stays as it is.
5. **Retry semantics come from the history.** A failed design records `complete design fail`, which is not a `reject`, `tier` or `escalate` entry. The latest relevant entry is therefore still the marked `escalate`, and the retry is a revision with the same context. `planRevision` is unchanged because only lifecycle transitions modify it.
6. **No prompt template change.** `src/prompts.ts` keeps its wording. The rejection path already works with it, and the binding revision request and the "Current plan files (revise them)" block tell the designer what to revise. The spec delta records that a revision may keep files.
7. **Approval binding.** The cleared `planDigest` and the incremented `planRevision` mean that `approve --revision 4` fails with `plan_moved`. The task stops at `DESIGNED` with `awaiting_plan_approval` (or goes to delegated review if delegation is on).

## Impact zone

- src/lifecycle.ts
- src/stages.ts
- test/lifecycle.test.ts
- test/run.test.ts
- docs/DEVELOPMENT.md

## Test plan

Run the new lifecycle and end-to-end regressions before the first production edit. Confirm the old revision in the lifecycle test and the `stale_delta` failure in the design report. After the implementation, rerun the same cases before the complete suite.

- **Second rework starts revision 5** (task-lifecycle): a new unit test in `test/lifecycle.test.ts`. A medium task in `PLAN_APPROVED` with `planRevision: 4`, a `planDigest` and a `gatesSnapshot` plays implement ok, gates pass, verify rework, implement ok, gates pass, verify rework. Assert: tier `complex`, status `EXPLORED`, `planRevision === 5`, no `planDigest` and no `gatesSnapshot`, exactly one `escalate` entry, with `reason: "rework_repeated"`, `from: "medium"`, `to: "complex"` and `results: "revision 5"`. Extend the existing "second rework on medium escalates to complex" test, or add a test next to it.
- **Gate triggers start a revision too**: a unit test for `zone_violation` and `gates_failed_repeatedly` on medium at revision 2. Assert revision 3 and `results: "revision 3"`.
- **Failed design retry keeps the revision** (lifecycle part): after the escalation, play `design fail` and then `design ok`. Assert `planRevision` stays 5 and the status is `DESIGNED`.
- **Old revision cannot be approved**: `transition(..., { kind: "approve", revision: 4 })` on the escalated `DESIGNED` task rejects with `plan_moved`.
- **Small escalation does not start a revision**: extend "small escalates to medium and restarts at explore with recorded reason". Assert `planRevision` is unchanged and `results` is undefined.
- **Escalation context reaches the designer** and **Escalated redesign awaits approval**: a new end-to-end test in `test/run.test.ts` with `setup({ FAKE_VERDICT: "REWORK" })`, which has no model cost.
  1. Start a medium task, run, and reject three times (`approve --reject`, then `run` after each) to reach revision 4, then approve.
  2. Run until the loop stops. The verify REWORK results are 2, then the loop escalates and runs design.
  3. Assert: tier `complex`, `planRevision` 5, status `DESIGNED`, the last run line is `awaiting_plan_approval`, exactly one `escalate` entry with `results: "revision 5"`, no design report with `stale_delta`, and the design report has `details.revision === 5`.
  4. The last saved `DESIGN-*` prompt contains `rework_repeated`, `Current plan files (revise them)` and the fake verdict text (`VERDICT: REWORK`).
- **Retry stays a revision**: an end-to-end test in `test/run.test.ts`. As above, but the design run after the escalation uses `FAKE_FAIL_ROLE: "DESIGN"` (so design records `fail` and the task stays `EXPLORED` at revision 5). The retry runs without it. Assert `planRevision` is 5 after both runs, the retry design prompt again contains the escalation context, and the task ends `DESIGNED`.
- **Revision keeps a spec delta**: covered by the end-to-end tests above. The fake agent writes byte-identical plan files on every design prompt, so `specs/math/spec.md` keeps its pre-run hash. On today's code this is exactly the `stale_delta` failure. After the change, the escalation design must succeed, with reason `plan_files_unchanged` or none, and no report may contain `stale_delta`.
- **Revision still needs a usable plan**: covered by the existing `checkDesign()` assertions in `test/prompts.test.ts`, called without `before` (`missing_spec_delta`). The revision path calls the same function unchanged.
- **Stale spec delta** (first plan): the existing `test/prompts.test.ts` "design checks: files, zone, test plan, stale deltas, validation modes" stays unchanged and must pass.
- **Unchanged design-stage contracts** (Design cannot touch source, Missing facts, Implementer may regenerate) and rejection revisions: existing tests, including "a rejected plan goes back to design as a new revision; unchanged files are flagged, not failed", must still pass.
- Full suite: `npm test` (builds with `tsc`, then runs `node --test`).
