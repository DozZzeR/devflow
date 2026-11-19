# Tasks

Execution order (stable task IDs): write the regression tests in 1.2, 3.1 and 3.2 first. Run them against the current code and capture the revision staying at 4 and the design report with `stale_delta`. Then implement 1.1 and 2.1, rerun the same tests to green, and complete 2.2, 2.3 and 4.1.

## 1. Escalation starts a plan revision (lifecycle)

- [x] 1.1 In `autoEscalate` in `src/lifecycle.ts`, for an automatic `medium` → `complex` escalation: increment `planRevision` (`(t.planRevision ?? 1) + 1`), delete `planDigest` and `gatesSnapshot`, and add `results: "revision <N>"` to the `escalate` history entry. Leave `small` → `medium`, `complex` → `HUMAN`, manual `escalate` and `tier` unchanged. Scenarios: "Second rework starts revision 5", "Gate triggers start a revision too", "Small escalation does not start a revision". Depends on the failing tests in 1.2, 3.1 and 3.2. Verify: the lifecycle tests in 1.2 now pass.
- [x] 1.2 Add unit tests to `test/lifecycle.test.ts`:
  - second medium `rework` at revision 4 → `complex`/`EXPLORED`, revision 5, no digest or snapshot, exactly one `escalate` entry with `rework_repeated` and `results: "revision 5"`;
  - `zone_violation` and `gates_failed_repeatedly` at revision 2 → revision 3;
  - `design fail` then `design ok` keeps revision 5 and ends `DESIGNED`;
  - `approve` with revision 4 → `plan_moved`;
  - `small` → `medium` leaves `planRevision` unchanged and has no `results`.

  Scenarios: all task-lifecycle scenarios. Verify before changing production code: the second-rework test fails because the observed revision stays at 4.

## 2. Design stage treats escalation as a revision

- [x] 2.1 In the `design` branch of `src/stages.ts`, treat the latest relevant history entry as the revision request when it is a `reject`, or an `escalate` entry whose `results` matches `/^revision \d+$/`. For an escalation, build the binding text from the trigger and the tiers, for example `Automatic escalation medium → complex (rework_repeated): …`. Set `revision` from the presence of a request, not from the length of a rejection reason. For every revision, add the current plan files and `reworkFeedback(root, task, true)`, keep `required = []`, and call `checkDesign()` without `before`. Keep `reviseNode` only for requests that have a `node`. Scenarios: "Escalation context reaches the designer", "Revision keeps a spec delta", "Retry stays a revision". Depends on 1.1. Verify: the end-to-end tests in 3.1 and 3.2 pass.
- [x] 2.2 Keep the first-plan freshness path unchanged: `checkDesign(..., before)` with all three root files required when there is no revision request. Scenarios: "Stale spec delta", "Revision still needs a usable plan". Verify: the existing `test/prompts.test.ts` test "design checks: files, zone, test plan, stale deltas, validation modes" passes unmodified, and the existing rejection test "a rejected plan goes back to design as a new revision; unchanged files are flagged, not failed" in `test/run.test.ts` still passes.

- [x] 2.3 Update `docs/DEVELOPMENT.md` and the affected routing JSDoc. Describe the one-time revision bump, evidence for each trigger, design retries, and human or delegated approval of the new revision. Verify the routing table and recovery guidance against 1.2 and 3.1–3.2.

## 3. End-to-end with the fake agent (no model cost)

- [x] 3.1 Add a test to `test/run.test.ts` using `setup({ FAKE_VERDICT: "REWORK" })`:
  1. Start a medium task, then reach revision 4 with three `approve --reject` and `run` cycles, then approve.
  2. Run until the loop stops.
  3. Inspect the design report first, so an unchanged revision cannot hide a failure with `stale_delta`. Assert: tier `complex`, `planRevision` 5, status `DESIGNED`, the last run line is `awaiting_plan_approval`, exactly one `escalate` entry (`rework_repeated`, `results: "revision 5"`), the design report has `details.revision === 5`, and no report contains `stale_delta`.
  4. Assert the last `DESIGN-*` prompt contains `rework_repeated`, `Current plan files (revise them)` and `VERDICT: REWORK`.

  Scenarios: "Second rework starts revision 5", "Escalation context reaches the designer", "Escalated redesign awaits approval", "Revision keeps a spec delta". Verify before changing production code: the unchanged spec delta causes design to fail on the escalation. After 2.1 the same test reaches approval.
- [x] 3.2 Add a test to `test/run.test.ts`: the same flow to the escalation, but the first design after the escalation runs with `FAKE_FAIL_ROLE: "DESIGN"`. Assert design `fail`, status `EXPLORED` and revision 5. Then retry without the failure. Assert revision 5, the retry prompt has the escalation context, and the status is `DESIGNED`. Scenarios: "Retry stays a revision", "Failed design retry keeps the revision". Use the fixture flow from 3.1. Write and run this regression before the production changes, then rerun it after 2.1.

## 4. Whole suite

- [ ] 4.1 Run the full build and test suite. Scenarios: all of the above plus the unchanged existing scenarios. Depends on 1.1, 1.2, 2.1, 2.2, 2.3, 3.1 and 3.2. Verify: `npm test` exits 0, with `tsc` and every `node --test` file passing.
