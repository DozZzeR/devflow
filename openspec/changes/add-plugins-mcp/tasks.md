# Tasks

## 1. Roles

- [x] 1.1 `src/roles.ts` cross-vendor ranking, propose (`--probe` through runRole, `--apply`, zero/one candidates), set (`--command`, atomic); CLI `devflow roles`; init presets without Fable; node version in doctor; verify `test/roles.test.ts`

## 2. Approval delegation

- [x] 2.1 `approval` field (legacy default human), `delegate-approval --to model|human`, `--revision` on approve/reject with `plan_moved`, `review` role (claude/codex only), isolated plan-only review with stale check; verify `test/review.test.ts` and lifecycle tests

## 3. MCP server

- [x] 3.1 Generalised background jobs; `devflow mcp` with project location rules, task, job, log and role tools, error mapping and human-decision tool descriptions; verify `test/mcp.test.ts`

## 4. Plugins

- [x] 4.1 `skills/devflow`, `skills/devflow-roles`, `skills/devflow-approval`
- [x] 4.2 `scripts/build-plugins.mjs` (esbuild bundle, two layouts, manifests, `.mcp.json`), marketplace files, `npm run build:plugins`; bundle-safe paths for hook and background runner; verify `test/plugins.test.ts`

## 5. Docs, real checks, integration

- [x] 5.1 README (install from marketplace for Claude Code and Codex, MCP tools, roles, delegation), SPEC §8, TODO
- [x] 5.2 Real checks: install the Claude Code plugin from this repo and call a devflow tool; install the Codex plugin and call a devflow tool; record outcomes here and in the journal
  - Outcome 2026-11-18 (docs/sandbox-calc): Claude Code `claude -p --plugin-dir plugins/claude/devflow` called devflow_status and devflow_roles through the plugin's MCP server and reported both tasks and the verify role. Codex `codex exec` with the plugin's MCP launch (cwd = plugin folder) found the project through `projectDir`; MCP calls were blocked until tools were approved, so the Codex plugin now pre-approves read-only tools only. A marketplace install from GitHub is still to be done by the owner (needs the branch merged).
- [x] 5.3 `npx openspec validate add-plugins-mcp --strict`, `npx openspec validate --specs --strict`, `npm test`
- [x] 5.4 Independent verify by Codex (two rounds max, round 2 high-only)
  - Round 1: REWORK, 14. Fixed: review prompt had verdict-shaped lines that codex echoes into its log (a real misread risk), review now binds the digest of the copy it judged; log paths validated and kept inside .devflow; gate all takes the task lock; approve checks status and revision before design checks; MCP roles_set returns invalid_config; plugin build refuses to replace unrelated directories. Deferred items are in docs/TODO.md.
  - Round 2 (limit, high-only): 3 open. Fixed: spec says the last verdict line decides (as the prompt asks); approval re-checks state, delegation and digest after the asynchronous design checks. Remaining (symlink-forged job/log records, locks for single gates and probes) deferred in docs/TODO.md for the human decision.

## Workflow follow-up

- Archive with `openspec archive add-plugins-mcp`, then `openspec validate --specs --strict`.
