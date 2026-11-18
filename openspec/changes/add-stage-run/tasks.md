# Tasks

## 1. Prompts and artifacts

- [ ] 1.1 Stage prompt templates, composition, language, project overrides, saved prompt; verify `test/prompts.test.ts`
- [ ] 1.2 Design post-checks and OpenSpec validation modes, zone from design into task state; verify `test/artifacts.test.ts`

## 2. Verdicts

- [ ] 2.1 Verdict parsing, change-set hash, `lastVerdict.hash`, `invalidate_verdict` event and stale check; verify `test/verdict.test.ts` and lifecycle tests
- [ ] 2.2 Verify rounds: archive previous verdict, round-2 narrowing; verify prompt tests

## 3. Run loop

- [ ] 3.1 `src/stages.ts` stage → runRole contracts and outcome recording; `devflow run <id> [--once]`; verify `test/run.test.ts` with fake CLIs

## 4. Background

- [ ] 4.1 `--detach`, `run.json`, `devflow log [--follow]`, active run in `status`, `run_active`, stale cleanup; verify `test/background.test.ts`

## 5. Docs, real runs, integration

- [ ] 5.1 README (run, log, prompts override, artifacts), SPEC §8.1/§6 status, TODO updates; verify documented commands
- [ ] 5.2 Real runs on a scratch repo: one small and one medium task end to end with real CLIs; record in the `docs/TODO.md` run journal
- [ ] 5.3 `npx openspec validate add-stage-run --strict`, `npx openspec validate --specs --strict`, `npm test`
- [ ] 5.4 Independent verify by Codex (two rounds max, round 2 high-only and regressions); record in the journal

## Workflow follow-up

- Archive with `openspec archive add-stage-run`, then `openspec validate --specs --strict`.
