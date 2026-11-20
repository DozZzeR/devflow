# How devflow works

This guide is for developers changing devflow or investigating a stalled run. Start with `devflow status <id> --json` and `devflow next <id>`. The `status` field shows the last saved state. The next action appears in the `next` field of `status` and the `stage` field of `next`. The `reason` field explains why the task is waiting. For example, `DESIGNED` and `stage: null` usually mean the plan is ready for a decision. `status: DONE` confirms task completion. The `done: true` field on the last line of `run` means that command invocation has finished.

## Who makes decisions

| Participant | Input | Output |
|---|---|---|
| `explore` | Task description and project access | Records research findings for the designer. |
| `design` | Research findings, task statement, spec context, and revision feedback | Prepares an OpenSpec change with requirements, an impact zone, a test plan, and numbered tasks. On `complex`, it selects `design_complex` if configured. Breaking down the work is part of this role. |
| Human or delegated `review` role | Plan revision. The model receives a separate copy of the plan | Approves the plan or returns it with a reason. A human decides by default. Use `delegate-approval <id> --to model` to delegate. The model is selected in the order `review`, `design_complex`, `design`. Claude and Codex are supported. |
| `implement` | Approved plan, zone, and feedback from previous attempts | Changes the working tree, adds tests, and reports a blocker or plan conflict. For `small`, the configured `small` role runs. |
| `gates` | Base commit, working tree, zone, and test rules | Runs automated checks. Returns `pass`, `fail`, or `blocked` with evidence. |
| `verify` | Isolated copy of the result, requirements, and verification context. The copy excludes devflow’s internal state and the current change’s `design.md` | Returns `VERDICT: PASS`, `VERDICT: REWORK`, or `VERDICT: HUMAN`. A follow-up round focuses on serious defects and regressions involving previously identified issues. |

A role produces an artifact or assessment. The orchestrator validates it and proposes an event. The `transition` function computes the allowed new state. Before recording a stage result, the orchestrator checks the saved `updatedAt` against the value at stage start. For delegated decisions, it separately checks authority, revision, and plan contents. View model assignments with `devflow roles`. [Routing](../src/lifecycle.ts) · [Stage execution](../src/stages.ts) · [Delegated decision validation](../src/review.ts)

## How to read the transitions

| Saved status | Normal next action | What triggers the next transition |
|---|---|---|
| `NEW` | On `small`, run `implement` immediately. On `medium/complex`, run `explore` | Successful implementation advances to `IMPLEMENTED`. Successful exploration advances to `EXPLORED`. |
| `EXPLORED` | `design` | A valid plan advances to `DESIGNED`. Plan rejections and automatic escalations from `medium` to `complex` return here for a revision. |
| `DESIGNED` | Wait for a plan decision. With delegation enabled, `run` invokes `review` | Approval advances to `PLAN_APPROVED`. Rejection creates a new revision and returns to `EXPLORED`. |
| `PLAN_APPROVED` | `implement` | Success advances to `IMPLEMENTED`. A conflict can return the plan to design. |
| `IMPLEMENTED` | `gates` | On success, `small` finishes at `DONE`. Other tiers advance to `GATES_PASSED`. |
| `GATES_PASSED` | `verify` | `PASS` on the current snapshot advances to `DONE`. `REWORK` starts a correction cycle or escalates. `HUMAN` hands the decision to a human. |
| `HUMAN` | The operator reads `humanReason` and the history | After resolving the cause, `approve <id> --resume` resets the implement/verify attempts and returns to implementation. For a plan conflict, a separate action returns to design by revision number. |
| `DONE` | The automatic cycle is complete | History and evidence remain available for investigation. |

`review` is an action at the approval point. `REWORK` is a verification outcome. One module defines the statuses, role selection, and transition rules. History and attempt counts are saved in `.devflow/runs/<id>/state.json`. Previously saved state is validated on read. [Schema and transitions](../src/lifecycle.ts) · [Store](../src/store.ts) · [Transition tests](../test/lifecycle.test.ts)

## What to do when a run stops

| Observation | How the decision was made | Next action |
|---|---|---|
| `awaiting_plan_approval` | Automatic execution reached the approval point | Read the change and the revision number from `devflow nodes <id>`, then approve the revision you reviewed or return feedback. After three model rejections, authority returns to the human. |
| `PLAN CONFLICT: [2.1/test] …` from the implementer | For an approved plan, the orchestrator recognizes the issue key and an existing node ID. The first conflict sends the plan back to design. A second conflict with the same key in the tracked sequence leads to `plan_conflicts_limit`. | Check the wording of the node and its dependent requirements. When this is the reason for `HUMAN`, use `approve --revision … --reject … --node …` to send the node back. |
| `stale`, `plan_changed` or `snapshot_changed` | The stale reviewer response is discarded. A changed approved plan needs approval again. Changing an already checked snapshot requires rerunning gates. The third invalidation leads to `HUMAN`. | Check the revision, snapshot, and history before the next run. |
| Gate `fail` | A zone violation escalates immediately. Other failures return to implementation until `limits.escalate_after` is reached. At `complex`, a gate escalation goes to `HUMAN`. | Review the failed gate, its reason and its recorded evidence. |
| `blocked` at gates or `BLOCKED: …` from the implementer | The check or work cannot continue under the current conditions. The task moves to `HUMAN`. A role blocker does not consume an implementation attempt. | Resolve the cause in the log. `--resume` resumes implementation even after a stop at another stage. |
| `VERDICT: REWORK` | The attempt counts toward the verify and rework limits. The second `REWORK` on `medium` escalates to `complex` and starts a plan revision. | Review the latest verify findings. The designer receives them with the current plan and the escalation reason. |

An automatic escalation from `medium` to `complex` increments `planRevision` once, clears the approval digest and gates snapshot, and records the trigger and `revision <N>` in history. The designer receives the current plan and a binding request naming the tier change and trigger. The context includes the triggering stage outcome and any recorded reason, including for outcomes entered with `devflow complete`. For `rework_repeated`, a verify run also supplies its verdict. For `zone_violation` or `gates_failed_repeatedly`, a gate run supplies its failed gate report, even if verify has yet to run. Detailed evidence is saved with the escalation that it triggered.

After a failed design, run the task again to retry the same revision with the same escalation context. Design can retain valid plan files and spec deltas. Once design succeeds, approve the new revision at `DESIGNED`, or let `run` invoke the delegated reviewer when delegation is enabled. Approval using the old revision returns `plan_moved`.

`run --once` performs at most one orchestrator action. A normal `run` can perform several stages per invocation. In the main loop, `fail` and `blocked` end the invocation with code 1. Waiting for a decision and some human and stale outcomes can exit with code 0. For integrations, read `outcome`, `next.status`, and `next.reason` from JSON. [Run loop](../src/stages.ts) · [CLI](../src/cli.ts) · [Integration scenarios](../test/run.test.ts)

## Where to find the reason for a decision

| What to check | What it explains |
|---|---|
| `devflow next <id>`, `devflow status <id> --json` | What can run now, who receives the work, and which attempt is next? |
| `.devflow/runs/<id>/state.json` | Which events have been recorded, which `base` was selected, which snapshot was checked, and why did the task reach `HUMAN`? |
| `openspec/changes/<id>/`, `devflow nodes <id>` | Which requirements, tests, and nodes are up for approval, and which revision do they belong to? |
| `.devflow/runs/<id>/facts.md`, `review.md`, `verdict-round<N>.md` and `logs/` inside the run directory | What facts did the designer receive, how did the reviewer respond, what findings did the verifier record, and what command ran? Files appear as the corresponding stages run. |

For background execution, use `devflow run <id> --detach` and `devflow log <id> --follow`. Competing runs of the same task check the lock. An active lock returns `run_active`. If the state changes during a stage, `record` checks it before writing and may return `state_changed`. The version check and atomic file replacement cover different operations. [Run locking](../src/background.ts) · [State writes](../src/store.ts) · [Background run tests](../test/background.test.ts)

## How to revise one OpenSpec node

Approval covers the entire `openspec/changes/<id>/` directory. In `tasks.md`, each node has a stable ID, for example `- [ ] 2.1 Check the timeout error`. Specify an observable result, dependencies on other nodes, and the test that determines completion.

1. Check the task state. In the output of `devflow nodes <id>`, `revision` contains the current revision and `nodes` lists the tasks. Check the node against the requirements and related tasks.
2. To request a targeted clarification, run, for example, `devflow approve export-csv --revision 3 --reject "State the result for an empty file" --node 2.1`. The revision number in the command must match the revision you reviewed.
3. At the next design stage, the designer sees the entire plan and writes a separate candidate. Devflow checks that there is one open node with the same ID and checks its indentation, the state update timestamp, and the plan hash. It then replaces that fragment. The other tasks stay as they are. If a shared requirement, the zone, or several dependent tasks change, send the whole plan back by omitting `--node`.
4. Review the whole change again and approve the new revision. Decisions on verify findings are tied to the round number and an ID such as `F1`. Verify groups findings in `## Findings`. The section on test execution uses its own numbering. Older verdicts can use a list before the first Markdown heading. With `fix`, the implementer receives the original finding and the approved instructions for fixing it. A duplicate verdict ID returns `invalid_verdict_findings`. A missing decision in the plan returns `invalid_plan_nodes`. A `fix` action references an existing node. The `defer` and `dismiss` actions specify `-` and explain why.

[Decision format and example](../README.md#revising-one-part-of-an-openspec-plan) · [Node replacement](../src/plan-nodes.ts) · [Replacement boundary tests](../test/plan-nodes.test.ts) · [OpenSpec artifact validation](../src/artifacts.ts)

## Where completion evidence comes from

1. By default, startup records the current Git HEAD as `base`. In the normal flow, approval binds the revision to the plan hash. Checkbox completion marks and line endings in `tasks.md` are normalized for the plan hash. The zone comes from the plan. The gates read test, setup, and generation rules from the base commit’s configuration. If the base has no configuration, a configuration changed in the working tree triggers `untrusted_config`.
2. `zone` compares changed paths against allowed patterns and declared generation outputs. The OpenSpec directory for the current task is allowed separately. For `small`, a missing zone produces the warning `no_zone`. For other tiers, it blocks the check.
3. `tests` runs the configured command in the working tree. `rollback` creates a temporary tree at `base`. The tests must first pass. The changed tests must then fail in an acceptable way without the implementation and pass once the full change is applied. This detects tests that already passed on the old code. A single `gate <id> tests` invocation provides diagnostics. A full `gate <id> all` invocation records the transition when the gates stage is expected.
4. After gates, the snapshot hash is saved. Before accepting `PASS`, the orchestrator checks it against the working tree again. Manually accepting gates or verify requires `--override` with a reason that is recorded in the history.

5. Roles do not repeat the full test suite. When the base-commit config has `test.focused`, implement, small and verify get only that command (a template with `{files}`). The Claude hook allows it only with files that match `test.paths` ([matcher](../src/focused.ts)). Verify relies on the gate results for the same snapshot and runs focused tests only for a concrete question the gates did not answer. The verdict separates evidence "confirmed by gates" from evidence "checked additionally".

[Checks](../src/gates.ts) · [Hashes](../src/snapshot.ts) · [Rollback tests](../test/gates.test.ts)

## Two run examples

These examples assume the project has devflow configured, a working test command, and available implementers.

```sh
devflow start csv-empty "Handle an empty CSV" --tier small --zone "src/**" --zone "test/**"
devflow run csv-empty
devflow status csv-empty --json

devflow start export-csv "Export the filtered records to CSV" --tier medium
devflow run export-csv
devflow nodes export-csv
devflow status export-csv --json
# After reading the first plan revision:
devflow approve export-csv --revision 1
devflow run export-csv
devflow next export-csv
```

## Change in progress — `run-robustness`

In the working version of this change, a recognized provider usage limit preserves the status and attempt number. The state gains `pause` with `stage`, `runner`, `reason`, `at`, and, when available, `reset`. With delegated approval, `next.stage: null` and `pause.stage: "review"` can occur together. The `run` invocation that records the pause exits with code 75. A subsequent `run` retries the action. The change also stores hashes of paths already modified before the first implementation attempt in `dirtyAtImplement` for the zone check. When investigating a run, check the version of the CLI binary. These fields belong to this change.

Revision 3 plans the next step. Node 7.3 should show `next.stage: "review"` when the delegated reviewer is paused. Node 7.4 adds a retry for temporary copy cleanup. The `removeDetached` contract matters here. The function deletes both the copy and its temporary parent directory. When recovering from `pendingCleanup`, the caller must confirm both paths belong to the task before invoking cleanup. [Creating and removing temporary copies](../src/git.ts)

## How to change devflow itself

1. To change behavior, describe an observable scenario, add a test, and run it before changing the code. Confirm it fails for the expected reason. Transition tests are in `test/lifecycle.test.ts`, plan decision tests are in `test/review.test.ts` and `test/plan-nodes.test.ts`, and the full flow through a mock implementer is in `test/run.test.ts`.
2. Change the layer that owns the decision. Pure transitions are in `src/lifecycle.ts`. Artifact handling and execution are in `src/stages.ts`. CLI and MCP are entry points. If you change the format, check retries and previously saved state.
3. Update JSDoc and this transition table in the same change if the contract changes. If requirements change, update OpenSpec and run strict validation on the relevant change.
4. The repository uses Node.js 22+. Install dependencies with `npm ci`. `npm run build` compiles TypeScript. To run one suite after building, use `node --test dist/test/lifecycle.test.js`. Rebuild the distributed plugins with `npm run build:plugins` and run `npm test`, including the check that builds are up to date.

[Required documentation rule](../.agents/instructions/DOCUMENTATION.instructions.md) · [Project specification](SPEC.md) · [Open tasks](TODO.md)
