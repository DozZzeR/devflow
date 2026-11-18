# Tasks

## 1. Prompts, artifacts, snapshots

- [ ] 1.1 Stage prompt templates, composition, language, project overrides, saved prompt; verify `test/prompts.test.ts`
- [ ] 1.2 Design post-checks (freshness incl. spec deltas, zone, validation modes) and plan digest; verify `test/artifacts.test.ts`
- [ ] 1.3 Snapshot digest (base, gate config, path, mode, content); gates record `gatesSnapshot`; zone gate allows the task's plan folder; verify `test/snapshot.test.ts` and gate tests

## 2. Lifecycle

- [ ] 2.1 `invalidate` event with `staleEvidence` counter and `evidence_unstable`; manual verify pass needs override; new state fields; verify lifecycle tests

## 3. Run loop and verify

- [ ] 3.1 `src/stages.ts` contracts, outcome recording, approval binding in `approve`, `devflow run <id> [--once]`; verify `test/run.test.ts`
- [ ] 3.2 Verify in an isolated worktree, verdict copy-back and parsing, snapshot binding, round-2 narrowing; verify `test/run.test.ts`

## 4. Background

- [ ] 4.1 Lock-first `--detach`, child acknowledgement, `devflow log [--follow]`, active run in `status`, stale and failed-start cleanup; verify `test/background.test.ts`

## 5. Docs, real runs, integration

- [ ] 5.1 README (run, log, prompts override, artifacts, evidence binding), SPEC §5/§6/§8 status, TODO; verify documented commands
- [ ] 5.2 Real runs on a scratch repo: one small and one medium task end to end with real CLIs; record in the `docs/TODO.md` run journal
- [ ] 5.3 `npx openspec validate add-stage-run --strict`, `npx openspec validate --specs --strict`, `npm test`
- [ ] 5.4 Independent verify by Codex (two rounds max, round 2 high-only and regressions); record in the journal

## Workflow follow-up

- Archive with `openspec archive add-stage-run`, then `openspec validate --specs --strict`.
