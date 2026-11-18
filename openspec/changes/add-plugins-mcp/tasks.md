# Tasks

## 1. Roles

- [ ] 1.1 `src/roles.ts` cross-vendor ranking, propose (`--probe` through runRole, `--apply`, zero/one candidates), set (`--command`, atomic); CLI `devflow roles`; init presets without Fable; node version in doctor; verify `test/roles.test.ts`

## 2. Approval delegation

- [ ] 2.1 `approval` field (legacy default human), `delegate-approval --to model|human`, `--revision` on approve/reject with `plan_moved`, `review` role (claude/codex only), isolated plan-only review with stale check; verify `test/review.test.ts` and lifecycle tests

## 3. MCP server

- [ ] 3.1 Generalised background jobs; `devflow mcp` with project location rules, task, job, log and role tools, error mapping and human-decision tool descriptions; verify `test/mcp.test.ts`

## 4. Plugins

- [ ] 4.1 `skills/devflow`, `skills/devflow-roles`, `skills/devflow-approval`
- [ ] 4.2 `scripts/build-plugins.mjs` (esbuild bundle, two layouts, manifests, `.mcp.json`), marketplace files, `npm run build:plugins`; bundle-safe paths for hook and background runner; verify `test/plugins.test.ts`

## 5. Docs, real checks, integration

- [ ] 5.1 README (install from marketplace for Claude Code and Codex, MCP tools, roles, delegation), SPEC §8, TODO
- [ ] 5.2 Real checks: install the Claude Code plugin from this repo and call a devflow tool; install the Codex plugin and call a devflow tool; record outcomes here and in the journal
- [ ] 5.3 `npx openspec validate add-plugins-mcp --strict`, `npx openspec validate --specs --strict`, `npm test`
- [ ] 5.4 Independent verify by Codex (two rounds max, round 2 high-only)

## Workflow follow-up

- Archive with `openspec archive add-plugins-mcp`, then `openspec validate --specs --strict`.
