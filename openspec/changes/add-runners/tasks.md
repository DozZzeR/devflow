# Tasks

## 1. Process helper

- [ ] 1.1 Implement `resolveCommand` (PATH + PATHEXT) and `launch` (stdin write+close, combined log, timeout with tree kill, `.cmd` via `cmd.exe` with metacharacter refusal); verify `test/proc.test.ts`

## 2. Runners

- [ ] 2.1 Implement `Runner` interface, result type and expected-output check; verify missing-output and result-shape tests in `test/runners.test.ts`
- [ ] 2.2 Implement `claude` runner argument building with enforced write scope; verify exact-args tests
- [ ] 2.3 Implement `codex` runner (sandbox mode, `--ephemeral`, `-C`, `ignore_user_config` option); verify exact-args tests
- [ ] 2.4 Implement `command` runner with template expansion and `invalid_template`; verify tests

## 3. CLI

- [ ] 3.1 Add `devflow exec-role` with logs under `.devflow/runs/<task>/logs` or `.devflow/logs`; add `logs/` to `.devflow/.gitignore`; verify `test/cli-runners.test.ts` with fake CLIs
- [ ] 3.2 Add CLI detection and `--runners` to `init`, update defaults (Codex model); verify codex-only, claude-only and override scenarios
- [ ] 3.3 Add `devflow doctor [--probe]`; verify with fake CLIs, then run `doctor --probe` for real on the author's machine and confirm `--ignore-user-config` keeps the ChatGPT login (record outcome in this task)

## 4. Docs and integration

- [ ] 4.1 Update `README.md` (exec-role, doctor, init `--runners`) and `docs/SPEC.md` §5.1 with the stdin and Windows findings; verify documented commands run
- [ ] 4.2 Run `npx openspec validate add-runners --strict` and `npm test`; both pass
- [ ] 4.3 First real independent check: run `devflow exec-role verify` (Codex) over the change-1 code and specs with a read-only scope; record the verdict and any findings

## Workflow follow-up

- Archive with `openspec archive add-runners` after review and merge.
