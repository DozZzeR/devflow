# Tasks

## 1. Git and change set

- [ ] 1.1 Implement `src/git.ts` (toplevel/prefix mapping, HEAD, change set with `-z`, worktree add/remove with retries) and shell-safe test-command execution in `src/proc.ts`; verify `test/git.test.ts`

## 2. Lifecycle, state, config

- [ ] 2.1 State schema 2 (`base`, `zone`, `counters`) with schema-1 upgrade on load; verify store tests
- [ ] 2.2 Reducer: gates pass/fail/blocked events, escalation before limits, counter resets, HUMAN on complex, override required for manual gates ok; verify new `task-lifecycle` scenarios in `test/lifecycle.test.ts`
- [ ] 2.3 Config: `test.setup`, `test.setup_inputs`, `test.red_exit_codes`, `test.timeout_seconds`; verify config tests

## 3. Gates

- [ ] 3.1 Zone: parsing `## Impact zone`, zone gate with `no_zone` rules; verify `test/zone.test.ts`
- [ ] 3.2 Tests gate and rollback gate (pass/fail/blocked) in a temp worktree with setup, baseline, copy-based application, setup re-run on manifest changes and cleanup with retries; verify `test/rollback.test.ts`

## 4. CLI

- [ ] 4.1 `start` records base and `--zone`; `devflow zone <id> --from-design`; `devflow base`; `devflow gate <id> [zone|rollback|tests|all]` with lifecycle recording rules; `complete gates ok --override`; verify `test/cli-gates.test.ts`
- [ ] 4.2 Set `test.setup` to `npm ci` in this repository's `.devflow/config.json`, then run the gates on this repository's own `add-gates` work as a real check (record outcome here)

## 5. Docs and integration

- [ ] 5.1 README (gates, base/zone, test settings, test-command environment), SPEC §4.4 (no draft.patch/reset) and §7 status, TODO (ignored-path writes, per-file rollback); verify documented commands
- [ ] 5.2 `npx openspec validate add-gates --strict`, `npx openspec validate --specs --strict` and `npm test` pass
- [ ] 5.3 Independent verify by Codex via `devflow exec-role verify`; record verdicts in the `docs/TODO.md` run journal

## Workflow follow-up

- Archive with `openspec archive add-gates`, then `openspec validate --specs --strict`.
