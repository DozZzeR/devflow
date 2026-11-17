# Tasks

## 1. Scaffold

- [ ] 1.1 Add `tsconfig.json` (ESM, strict, `outDir: dist`), `.gitattributes` (`* text=auto eol=lf`), scripts `build` / `test` and `bin` in `package.json`; add `zod`, `typescript`, `@types/node`; verify `npm run build` produces `dist/cli.js`

## 2. Configuration

- [ ] 2.1 Implement config schema (zod strict), loader with root discovery and error flattening; verify `test/config.test.ts` covers valid, unknown field, missing role, command without template
- [ ] 2.2 Implement `devflow init` (config defaults + `.devflow/.gitignore`), idempotent; verify fresh/idempotent scenarios in `test/config.test.ts`

## 3. Lifecycle core

- [ ] 3.1 Implement pure reducer and `nextStage` for all tiers, outcomes, limits, approve/resume/tier, escalation; verify every `task-lifecycle` scenario in `test/lifecycle.test.ts`
- [ ] 3.2 Implement state store (schema 1, atomic write with retry, invalid_state, duplicate refusal); verify `test/store.test.ts`

## 4. CLI

- [ ] 4.1 Implement `init | start | next | complete | approve | tier | escalate | status` with exit codes and `--json`; verify `test/cli.test.ts` end-to-end for small and medium paths
- [ ] 4.2 Add a "Usage" section to `README.md` with the command list; verify each documented command runs in a temp project

## 5. Integration check

- [ ] 5.1 Run `npx openspec validate add-core-state-machine --strict` and `npm test`; both pass

## Workflow follow-up

- Archive with `openspec archive add-core-state-machine` after review and merge.
