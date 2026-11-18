# Tasks

## 1. Prompts, artifacts, snapshots

- [x] 1.1 Stage prompt templates, composition, language, project overrides, saved prompt; verify `test/prompts.test.ts`
- [x] 1.2 Design post-checks (freshness incl. spec deltas, zone, validation modes) and plan digest; verify `test/artifacts.test.ts`
- [x] 1.3 Snapshot digest (base, gate config, path, mode, content); gates record `gatesSnapshot`; zone gate allows the task's plan folder; verify `test/snapshot.test.ts` and gate tests

## 2. Lifecycle

- [x] 2.1 `invalidate` event with `staleEvidence` counter and `evidence_unstable`; manual verify pass needs override; new state fields; verify lifecycle tests

## 3. Run loop and verify

- [x] 3.1 `src/stages.ts` contracts, outcome recording, approval binding in `approve`, `devflow run <id> [--once]`; verify `test/run.test.ts`
- [x] 3.2 Verify in an isolated worktree, verdict copy-back and parsing, snapshot binding, round-2 narrowing; verify `test/run.test.ts`

## 4. Background

- [x] 4.1 Lock-first `--detach`, child acknowledgement, `devflow log [--follow]`, active run in `status`, stale and failed-start cleanup; verify `test/background.test.ts`

## 5. Docs, real runs, integration

- [x] 5.1 README (run, log, prompts override, artifacts, evidence binding), SPEC §5/§6/§8 status, TODO; verify documented commands
- [x] 5.2 Real runs on a scratch repo: one small and one medium task end to end with real CLIs; record in the `docs/TODO.md` run journal
  - Outcome 2026-11-18 (docs/sandbox-calc): small `fix-sub` DONE in 20 s; medium `add-muldiv` went explore → design → reject → redesign → approve → implement → gates → verify REWORK → implement → gates → verify PASS. Real runs exposed three prompt/check issues, all fixed: design Outputs listed only three files; revision freshness rule; verify REWORK on low findings and confusion about the intentionally missing design.md.
- [x] 5.3 `npx openspec validate add-stage-run --strict`, `npx openspec validate --specs --strict`, `npm test`
- [x] 5.4 Independent verify by Codex (two rounds max, round 2 high-only and regressions); record in the journal
  - Round 1: REWORK, 11. Fixed: gates re-check the snapshot after running (change during the run is blocked); verify copy detached from git; launch errors are failed stages; round-2 rule enforced with custom prompts; approve validates the id first.
  - Round 2 (limit, high-only): 1 accepted (test-command environment), 3 open. Cheap ones fixed: verdict copied only as a regular file; approve refuses a run-designed task whose plan folder disappeared. Remaining (gates on the live tree vs a snapshot copy; codex verifier command freedom; plan-file links) are in docs/TODO.md for the human decision.

## Workflow follow-up

- Archive with `openspec archive add-stage-run`, then `openspec validate --specs --strict`.
