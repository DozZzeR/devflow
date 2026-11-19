# Design: run-robustness

## Context

`runRole` (`src/runners.ts`) streams a redacted log and returns a `RunResult` that does not say why a run failed. `runNextStage` (`src/stages.ts`) turns every `ok: false` into a `complete … fail` event. `transition` (`src/lifecycle.ts`) then counts that as an attempt and may escalate or set `HUMAN` with `limit_reached`. `runLoop` stops on `fail`, and `devflow run` (`src/cli.ts`) exits 1. So a subscription usage limit costs an attempt and can end a task's run.

`zoneGate` (`src/gates.ts`) checks `changeSet(root, task.base)` (`src/git.ts`) against the zone. It cannot see who made a change. A human's outside-zone edit therefore fails the gate with `outside_zone`, and `transition` escalates with `zone_violation`.

Claude runs use `--output-format json`, and their final line is a JSON result object. Codex output is plain text and starts with the echoed prompt. That matters here, because a prompt can itself contain words like "usage limit" (this task's description does).

The first implementation of this plan was verified with REWORK. Revisions 3 and 4 fixed these round 1 findings:

- Codex timeouts were classified as limits.
- Reset text lost embedded periods and missed resets on later lines.
- A delegated-review pause hid `review` as the next stage.
- A failed verify-copy removal during a pause was silently dropped.
- A test gap: attempts were not seeded before a pause.

Finding 4 (an ignore-rule change hiding a dirty file) is out of scope. See D5.

Verify round 2 found every requirement met except two partial ones in `src/limits.ts`. This revision (group 8 in tasks.md) fixes them:

- A Claude run killed after printing a usage-limit JSON object (null exit) was still classified as a limit. The null-exit rule now applies to every runner before either vendor branch.
- With two matching Codex lines in one error block (`ERROR: You've hit your usage limit. Try again at 5:00 PM.` then `ERROR: HTTP 429`), the reset search started at the last one and lost `5:00 PM`. The search now starts at the first matching line of that block.

Nothing else changes in this revision.

## Decisions

### D1. Detection lives in a pure module, `src/limits.ts`

`detectUsageLimit(runner, logText, exitCode): { runner, reset? } | undefined` holds every pattern, so it can be unit-tested without processes. `runRole` calls it after the log is closed, and only for `claude` and `codex`. It reads the redacted log file, the same text `verdictFromAnswer` reads. When the function returns a value, `runRole` sets `result.usageLimit` and forces `ok: false`.

- **Null exit, every runner**: the first statement of `detectUsageLimit` returns `undefined` when `exitCode === null`. A `null` exit (timeout, signal or kill) is **never** a limit, for Claude as for Codex, even when the log already holds a matching line. devflow did not see the process end on the provider limit, so it stays an ordinary failed run that counts an attempt. This is the only place that checks for `null`; the vendor branches below can assume a number.
- **Claude**: walk the log lines from the end. Take the first line that parses as a JSON object. It is a limit when `api_error_status === 429` or `api_error === "usage_limit_reached"`. Only structured fields decide, never free text. Any numeric exit code is accepted (0 included), because Claude may report an error result with exit 0.
- **Codex**: only when the exit code is non-zero. Scan the last 50 lines for the last line that matches `/error/i` and also matches `/usage limit/i` or `/\b429\b/`. The tail window and the non-zero exit keep a prompt echo, or an answer that quotes these words, from counting.
- **Reset search area**:
  - Claude: the whole `result` string, which may span several lines.
  - Codex: the **error block** of the last matching line `m`, inside the 50-line tail. Walk back from `m` over non-blank lines to find the **first matching line** `f` of the same block (stop at a blank line or the tail start; a non-matching non-blank line between them does not stop the walk, but `f` is always a matching line). The search area runs from `f` through the lines after `m` up to the first blank line or the end of the log, with at most 10 lines after `m`. Starting at `f`, not at the block start, keeps unrelated text printed just before the error (for example the end of an answer) out of the search. `resetText` takes the **first** reset phrase in the area, so the reset on `f` wins over later lines.
  - Examples: a reset on the line after `ERROR: You've hit your usage limit.` is found. `ERROR: You've hit your usage limit. Try again at 5:00 PM.` followed directly by `ERROR: HTTP 429` gives `5:00 PM` (round 2 finding 2).
- **Reset extraction** (`resetText`): find the first `resets`, `try again at` or `try again in` (case-insensitive) in the search area. Take the rest of that line up to `|` or the line end. Split it into whitespace-separated words and keep words until the first word that ends with `.`:
  - A dotted abbreviation (`/^(?:[a-z]\.){2,}$/i`, e.g. `p.m.`, `a.m.`) is kept whole and ends the reset.
  - Any other word ending in `.` loses that final period and ends the reset.
  - A period inside a word (`2.5`, `5:00`) never ends anything.

  Join the kept words with single spaces, trim, cap at 100 characters, and treat an empty result as no reset. Results:
  - `resets 5pm` gives `5pm`.
  - `Try again at 5:00 PM.` gives `5:00 PM`.
  - `Try again at 5 p.m.` gives `5 p.m.`.
  - `try again in 2.5 hours.` gives `2.5 hours`.

  A Claude `result` that ends in `|<digits>` gives an ISO UTC timestamp instead. Human times are **not** parsed, because their time zone and date are unknown, and devflow does not wait for the reset. A human or a scheduler runs `devflow run` again.

### D2. A pause is an event with its own state field, not a new status

Event `{ kind: "pause"; stage: Stage | "review"; runner: string; reset?: string }` goes through `transition`:

- The stage must equal `stageFor(task).stage`. The exception is `review`, which needs status `DESIGNED` and `approval === "model"`. Otherwise the event throws `stage_not_next`.
- It sets `t.pause = { stage, reason: "usage_limit", runner, at: now, reset? }` and pushes history `{ kind: "pause", stage?, reason: "usage_limit", to: reset }`. For `review`, `stage` is left out of history (the history `stage` enum stays as it is) and `results: "review"` is set.
- Status, attempts, counters and tier stay unchanged.
- At the top of `transition`, every event kind except `pause` does `delete t.pause`.

The pause event carries no cleanup path, and the task state stores none (see D3).

Why no `PAUSED` status: `stageFor` and every status-based check would then need to remember the stage the task paused in. Keeping the status means `--once`, the attempt numbers and the plan/snapshot invalidation checks all work as they do now. The retry is simply the same stage.

**`next` during a pause.** `nextStage` copies `task.pause` into `NextInfo.pause`. `NextInfo.stage` widens to `Stage | "review" | null`. When the status is `DESIGNED`, `approval === "model"` and `task.pause?.stage === "review"`, `nextStage` reports `stage: "review"`, keeps `reason: "awaiting_plan_approval"`, sets `role` to the review role (`reviewRole(config)`, moved or exported so lifecycle can use it without a cycle) and sets no `attempt`. `stageFor` itself is unchanged, so pause validation and the approval checks see the same state as before. A delegated review that has not paused still reports `stage: null` as today.

`runNextStage` dispatches `next.stage === "review"` to `runDelegatedReview`, just like the existing `stage === null && awaiting_plan_approval && approval === "model"` branch. Approval stays pending until the reviewer's verdict is recorded. `approve`, `reject` and every other event clear the pause, and `next` returns to `stage: null` or the following stage.

### D3. Stage handling

In `runNextStage`, a helper `pauseOn(r, extra?)` records the pause and returns `report("paused", task, "usage_limit", { reset, runner, log, ...extra })`.

- explore and design: check right after `runModel`, before the `ok`/`fail` record.
- implement: check right after `runModel`, before `parseBlocked`, `parsePlanConflict` and generate.
- verify: check after `runModel`, inside the try block. Skip the verdict copy, let `finally` remove the copy, then record the pause instead of `verify human`. On the retry, `round` is unchanged (no `complete verify` was added), and the archived verdict is found through `lastSavedVerdict`.
- delegated review (`src/review.ts`): check right after `runRole`, before parsing the verdict. Record the `review` pause and return outcome `paused`.

**Verify-copy removal fails during a pause.** In this case `removeDetached` returns false. The pause still wins, and the failure is only reported:

- The pause is recorded as usual, so attempts stay unchanged.
- The report is `paused` / `usage_limit` with `details.cleanup_failed = <copy path>`.
- The exit code stays 75.

devflow does **not** retry the removal later. It keeps no pending-cleanup state: no `pendingCleanup` field, no `cleaned` event or history kind, and no removal step at the top of `runNextStage`. Why: the copy lives in the OS temp directory, so leaving it there is harmless, and the OS or the user can clear it. A later retry would mean deleting a path read back from `state.json`. A tampered or corrupted state file could then point devflow at any folder. devflow only deletes a copy path it created in the same process. The next verify run creates a fresh copy, as it does today.

So that the test can force a failed removal, `StageIo` gets an optional `removeCopy?: (root, path) => boolean`, which defaults to `removeDetached`. It is a test seam only. `runVerify` calls it at the one existing removal point in `finally`, and nothing else calls it. The non-pause verify path keeps its current `cleanup_failed` handling.

**Run loop.** `runLoop` adds `"paused"` to its stop list. `devflow run` exits 75 (`EX_TEMPFAIL`) when the last report is `paused`. This is distinct from failure (1), so wrappers can tell "wait and retry" apart. The final summary line gets `outcome: "paused"` and `pause`. A detached job records that exit code through its normal path.

### D4. The dirty snapshot is captured once per task

`snapshot.ts` gains `pathHashes(root, paths): Record<string, string | null>`, using `lstat`:

- regular file: `sha256:<hex of bytes>`
- symbolic link: `link:<sha256 of readlink target>`
- missing: `null`

In the implement case, devflow records event `{ kind: "dirty_snapshot"; paths }` after the zone check and before the prompt and `runModel`. This happens when `task.base` exists, git is available and `task.dirtyAtImplement` is absent. The paths are `changeSet(root, base)` without `openspec/changes/<id>/`. The event sets `dirtyAtImplement = { at, paths }` only when it is absent, and pushes history `{ kind: "dirty", results: "<n> paths" }`.

Why only once, and not at every implement attempt: on a retry, rework or post-escalation implement, the working tree holds the earlier attempts' **role** edits. Recapturing would treat a role's own outside-zone edit from attempt 1 as human, and the next gate would let it through. Keeping the first snapshot means that only edits that existed before any role wrote count as human. Edits a human makes later are judged as before. This is the conservative failure mode.

A task that already passed its first implement before this change gets its snapshot at its next implement start. That snapshot also exempts only changes that exist at that point. This one-time migration effect is accepted.

### D5. Zone gate exemption is content-based

In `zoneGate`, compute `outside` as now. Then:

1. Split it into `exempt` and `counted`. A path is `exempt` when it is in the snapshot and `pathHashes(current) === snapshot[path]`. Everything else is `counted`.
2. Add to `counted` the snapshot paths that are outside the effective zone, not in the plan folder, and not in the current change set. These are paths the role reverted to the base, so they are role changes.
3. Fail if `counted` is non-empty, with `details.outside = counted`. Always add `warnings: exempt.map(p => "preexisting_change:" + p)` and `details.preexisting = exempt`.

A role that edits a dirty file and leaves it with exactly the snapshot content is treated as unchanged. devflow records no write operations, and the outcome on disk is the same. `changeSet`, `snapshotDigest`, the rollback inputs, the verify copy and `gateConfig` are not touched, so the evidence still covers human edits.

**Known limitation (out of scope).** Step 2 counts every snapshot path that left the change set, without hashing it. If an ignore-rule change hides an unchanged dirty untracked file, that file disappears from `changeSet` and the gate fails on it. This failure is conservative, because it blames the role and never hides a role change. This change does not handle it, and the existing behaviour and tests stay as they are.

### D6. Status display

`summary()` adds `pause: task.pause ?? null`. The text status prints one extra line under a paused task:

`    paused at <stage> since <at>: usage limit (<runner>), resets <reset>`

When there is no reset text, the line ends with `reset unknown` instead. `<stage>` is `review` for a review pause, and the summary's `next` is `review` too (D2).

### D7. Schema

`TaskStateSchema` gets the optional fields `pause` and `dirtyAtImplement`, as strict objects. There is no `pendingCleanup` field (D3).

`HistoryEntrySchema.kind` gets `pause` and `dirty`. The schema stays at version 2, and older files load as they are. An older devflow binary would reject a state file that contains the new fields. This is accepted.

### D8. Plugin bundles

`plugins/claude/devflow/bin/devflow.mjs` and `plugins/codex/devflow/bin/devflow.mjs` are generated from `src/**` by `scripts/build-plugins.mjs`. The zone lists `plugins/**` so that the implement role may write them and the zone gate accepts them, but nobody edits them by hand.

The implementer regenerates them with `node scripts/build-plugins.mjs <temp dir>`, with the temp dir outside the repository. It then copies only `<temp dir>/claude/devflow/bin/devflow.mjs` and `<temp dir>/codex/devflow/bin/devflow.mjs` over the two repository files and deletes the temp dir. This avoids the script's `rmSync` of the whole `plugins/` folder, a step that failed with access denied on Windows. It also leaves the other plugin files untouched. This happens before every full-suite checkpoint that follows a source change (task 7.6 before 7.7 in round 1, and 8.3 before 8.4 in this revision). devflow's own generate step rewrites the same files after implement, so the gate sees the same content.

## Impact zone

- src/limits.ts
- src/runners.ts
- src/stages.ts
- src/review.ts
- src/lifecycle.ts
- src/snapshot.ts
- src/gates.ts
- src/cli.ts
- test/limits.test.ts
- test/runners.test.ts
- test/run.test.ts
- test/review.test.ts
- test/lifecycle.test.ts
- test/gates.test.ts
- test/cli-gates.test.ts
- test/cli.test.ts
- test/fixtures/fake-agent.cjs
- test/fixtures/fake-cli.cjs
- plugins/**

## Test plan

Fake runners only. `test/fixtures/fake-agent.cjs` supports:

- `FAKE_LIMIT_ROLE` (the role name) and `FAKE_LIMIT_OUTPUT` (`claude-usage`, `claude-429`, `codex`). With these set, the fake prints the matching Claude JSON line or Codex error line and exits (1 for codex, 0 for the Claude JSON variant).
- `FAKE_IMPLEMENT_TOUCH=<path>[=<content>]`, so the implementer can edit, delete or revert an extra path.

**runners: Usage-limit detection / Reset text** (`test/limits.test.ts`, pure function)
- Claude usage limit: `usage_limit_reached` with `resets 5pm` gives `{ runner: "claude", reset: "5pm" }`.
- Claude rate limit without reset: `api_error_status: 429` gives no `reset`.
- Codex usage limit: exit 1 with the `ERROR: … Try again at 5:00 PM.` tail gives `reset: "5:00 PM"`.
- Timed-out Codex run is not a limit: exit `null` with an `ERROR: 429` line gives `undefined`.
- Killed Claude run is not a limit (round 2): a log whose final line is the `usage_limit_reached` JSON object with `resets 5pm`, exit `null`, gives `undefined`. The same log with exit 0 and with exit 1 still gives `{ runner: "claude", reset: "5pm" }`, so the null rule does not narrow the numeric case.
- Echoed prompt is not a limit: a 60-line log whose "usage limit" text is only in the first lines, exit 1, gives `undefined`.
- Successful run mentioning 429: exit 0 with an `error 429` line gives `undefined`.
- Punctuated reset: `ERROR: You've hit your usage limit. Try again at 5 p.m.` with exit 1 gives `reset: "5 p.m."`.
- Reset on a later line: `ERROR: You've hit your usage limit.` followed by `Upgrade to Pro or try again at 5:00 PM.` with exit 1 gives `reset: "5:00 PM"`.
- Several matching lines in one error block (round 2): `ERROR: You've hit your usage limit. Try again at 5:00 PM.` directly followed by `ERROR: HTTP 429`, exit 1, gives `reset: "5:00 PM"`. A second case puts a blank line between an earlier `ERROR: … try again at 3pm.` block and a final `ERROR: HTTP 429` line: the reset is absent, because the search does not cross the blank line into an older block.
- Decimal reset: `try again in 2.5 hours.` gives `2.5 hours`.
- Epoch reset: `…|1763571600` gives `2025-11-19T17:00:00.000Z`.
- Also: an ordinary Claude error JSON (`is_error` with no limit fields) gives `undefined`, and a `command` runner is never classified.

`test/runners.test.ts`: a fake `claude` that prints the usage-limit JSON gives `ok: false` and `usageLimit` in `runRole`'s result and in the `exec-role` JSON.

**stage-execution: Pause on a usage limit** (`test/run.test.ts`)
- Implement hits the limit: a small task with `FAKE_LIMIT_ROLE=IMPLEMENT`. The report has `paused`/`usage_limit`, `attempts.implement === 0`, the status is not `HUMAN`, and `next.stage === "implement"`.
- No generate after a limit: `build.generate` writes a marker file, and the marker is absent after the pause.
- Limited verify: a medium task goes through gates, then verify is limited. History has no `complete verify`, no copy is left (`git worktree list` lists only the main one), and a second run without the limit records verify round 1.
- Verify copy cannot be removed during a pause: call `runNextStage` directly with the verifier limited and `io.removeCopy` stubbed to return `false`. The report is `paused`/`usage_limit` with `details.cleanup_failed` equal to the copy path, `attempts.verify` is unchanged, the task has a `pause`, and `state.json` contains no copy path (no `pendingCleanup`, no `cleaned` history entry). The test then removes the leftover folder itself.
- Next run does not retry the removal: after that pause, a second `runNextStage` with the default `removeCopy` and no limit spies on `removeCopy`. It is called only for the new verify copy, never for the old path, and verify records round 1.
- Delegated review hits the limit (`test/review.test.ts`): with `approval: model`, the review is limited. The status is `DESIGNED`, `pause.stage === "review"`, and the stage report's `next.stage === "review"` with `reason: "awaiting_plan_approval"`. A CLI `devflow run` that pauses there has a final summary with `next.stage === "review"` and exits 75.
- Next run retries the review: after the review pause, a `devflow run` without the limit dispatches the reviewer (the first stage line is `review`), and approval stays pending until the verdict. With an APPROVE answer, the task becomes `PLAN_APPROVED` and the pause is gone.

**stage-execution: Run loop** (`test/run.test.ts`, CLI level)
- Stops on a pause: `devflow run` with design limited. Only explore and design lines appear, the last outcome is `paused`, the final summary has `next.stage === "design"` with `pause`, and the exit code is 75.
- Next run retries the stage: rerun without the env. The first stage line is `design`, with `attempt` equal to the value before the pause.
- `--once` with a limited stage also exits 75.

**stage-execution: Dirty snapshot at implement start** (`test/run.test.ts`)
- Human edit before implement: edit `README.md` and run a small task. `state.dirtyAtImplement.paths["README.md"]` is the SHA-256 of the file.
- Deleted file: delete a committed file first. It is stored as `null`.
- Retry keeps the first snapshot: implement attempt 1 touches `README.md` (`FAKE_IMPLEMENT_TOUCH`) and fails through `FAKE_FAIL_ROLE`, then attempt 2 runs. The snapshot hash equals the pre-run hash.
- Pause keeps the snapshot: a limited implement, then a retry. The `dirty` history entry appears once.

**task-lifecycle: Subscription pause / Optional state fields** (`test/lifecycle.test.ts`, pure `transition`)
- Pause keeps attempts: seed one failed implement attempt (`attempts.implement === 1`), then record a pause. `attempts.implement` stays 1, and `next` reports stage `implement`, attempt 2, and the pause.
- Also: pause for another stage (`stage_not_next`), pause cleared by the next outcome, and no human for limits (three pauses with `limits.implement: 1`).
- Review pause in `next`: a `DESIGNED` task with `approval: "model"` and a `review` pause has `next.stage === "review"` and `reason === "awaiting_plan_approval"`. After `approve`, it has no pause and `next.stage === "implement"`.
- Older state file: load a fixture schema-2 JSON without the new fields.

**task-lifecycle: Status overview** (`test/cli.test.ts`)
- Status as JSON (existing test).
- Paused task in text status: the line contains `paused`, `implement` and `resets 5pm`.
- Paused task in JSON status: `pause.stage === "design"` and no `reset`, and the text form contains `reset unknown`.

**gates: Pre-existing changes in the zone gate** (`test/gates.test.ts` with a git fixture and a task that has `dirtyAtImplement`)
- Unchanged human edit: pass with the warning.
- Role edits a dirty path: fail, listing `README.md`.
- Role reverts a dirty path: `git checkout README.md`, then fail, listing `README.md`.
- Pre-existing deletion kept: pass with `preexisting_change:docs/old.md`.
- New path outside the zone: fail with `notes.txt`.
- No snapshot: fail as before (the existing outside-zone test still passes).

`test/cli-gates.test.ts`: a task in `IMPLEMENTED` with an unchanged dirty `README.md`. `devflow gate t1` records gates pass (no `zone_violation` escalation), and the JSON output carries the warning.

**gates: Full change set for evidence** (`test/run.test.ts`)
- Snapshot covers exempted paths: gates pass with `README.md` exempted, then `README.md` is edited before verify. Verify reports `snapshot_changed`.

**Bundles** (`test/plugins.test.ts`, unchanged): run it after the temp-dir regeneration (D8). `git diff --stat plugins/` lists at most the two `bin/devflow.mjs` files.
