# Tasks

## 1. Git and change set

- [ ] 1.1 Implement `src/git.ts` (HEAD, change set with `-z`, worktree add/remove/prune) on top of `launch`; verify `test/git.test.ts`

## 2. Lifecycle and state

- [ ] 2.1 State schema 2 (`base`, `zone`, `counters`) with schema-1 upgrade on load; verify store tests
- [ ] 2.2 Reducer: gates result event, escalation triggers, counter resets, HUMAN on complex; verify new `task-lifecycle` scenarios in `test/lifecycle.test.ts`
- [ ] 2.3 Config: `test.setup`, `test.timeout_seconds`; verify config tests

## 3. Gates

- [ ] 3.1 Zone: parsing `## Impact zone`, zone gate with `no_zone` rules; verify `test/zone.test.ts`
- [ ] 3.2 Tests gate and rollback gate in a temp worktree with baseline, setup, copy-based application and guaranteed cleanup; verify `test/rollback.test.ts`

## 4. CLI

- [ ] 4.1 `start` records base and `--zone`; `devflow zone <id> --from-design`; `devflow gate <id> [zone|rollback|tests|all]` with lifecycle recording rules; verify `test/cli-gates.test.ts`
- [ ] 4.2 Run the gates on this repository's own `add-gates` work as a real check (record outcome here)

## 5. Docs and integration

- [ ] 5.1 README (gates, base/zone, test.setup), SPEC §7 status, TODO updates; verify documented commands
- [ ] 5.2 `npx openspec validate add-gates --strict`, `npx openspec validate --specs --strict` and `npm test` pass
- [ ] 5.3 Independent verify by Codex via `devflow exec-role verify`; record verdicts in `docs/TODO.md` run journal

## Workflow follow-up

- Archive with `openspec archive add-gates`, then `openspec validate --specs --strict`.
