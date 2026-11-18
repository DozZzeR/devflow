# Tasks

## 1. Process helper

- [ ] 1.1 Implement `resolveCommand` (PATH + PATHEXT) and `launch` (allowlisted child env with `runners.env.pass`, stdin write+close, timeout with tree kill, `.cmd` via `cmd.exe /d /v:off /s /c` with double quoting and metacharacter refusal for path and args); verify `test/proc.test.ts`
- [ ] 1.2 Implement log writer (validated task id, realpath containment in `.devflow`, exclusive create, redaction); verify `test/logs.test.ts`

## 2. Runners

- [ ] 2.1 Implement `Runner` interface, result type, `invalid_scope` check and fresh-output check (missing / stale / outside root); verify `test/runners.test.ts`
- [ ] 2.2 Implement `claude` runner: per-run settings file with PreToolUse hook, `dontAsk`, `--disallowedTools Bash` when no shell allowed, credential env stripping; verify exact-args tests
- [ ] 2.3 Implement `devflow hook pre-tool-use --scope-file`; verify `test/hook.test.ts`
- [ ] 2.4 Implement `codex` runner (sandbox mode, `--ephemeral`, `-C`, `ignore_user_config`, credential env stripping); verify exact-args tests
- [ ] 2.5 Implement `command` runner with template expansion and `invalid_template`; verify tests

## 3. CLI and config

- [ ] 3.1 Extend config schema with the `runners` section and the parser with repeatable flags; verify config and parser tests
- [ ] 3.2 Add `devflow exec-role`; verify `test/cli-runners.test.ts` with fake CLIs
- [ ] 3.3 Add CLI detection, `--runners`, no-CLI warning, `.gitignore` upgrade (`logs/`) to `init`, and `devflow doctor [--probe]`; verify with fake CLIs, then run `doctor --probe` for real and confirm `--ignore-user-config` keeps the ChatGPT login (record the outcome here)
- [ ] 3.4 Real-CLI check of the Claude hook: with a user-level allow-all edit rule, a `claude` run scoped to `tmp-scope/**` cannot edit a file outside it (record the outcome here)

## 4. Docs and integration

- [ ] 4.1 Update `README.md` (exec-role, doctor, init `--runners`) and `docs/SPEC.md` §5 with the stdin, Windows, hook and credential findings; verify documented commands run
- [ ] 4.2 Run `npx openspec validate add-runners --strict` and `npm test`; both pass
- [ ] 4.3 Independent check by Codex: `devflow exec-role verify` over this change's code and specs, read-only; record verdict and resolve findings

## Workflow follow-up

- Archive with `openspec archive add-runners` after review and merge.
