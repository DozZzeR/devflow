# Design

## Context

devflow has a CLI with run loop, gates, runners and background runs (`openspec/specs/*`). Plugin formats checked on 2026-11-18: Claude Code (`.claude-plugin/plugin.json`, `skills/`, `hooks/hooks.json`, `.mcp.json`, `${CLAUDE_PLUGIN_ROOT}`; `claude plugin validate`; git marketplaces via `.claude-plugin/marketplace.json`) and Codex (`.codex-plugin/plugin.json` with `skills` and `mcpServers` paths, `.mcp.json` with an `mcpServers` map; bundled OpenAI plugins on this machine use relative or absolute script paths with `cwd`; marketplaces in `.agents/plugins/marketplace.json`). Owner decisions of 2026-11-18 are in `docs/TODO.md`.

## Goals / Non-Goals

**Goals:**
- One runtime (the bundled CLI) behind every entry point: CLI, Claude Code plugin, Codex plugin, any MCP client.
- Skills written once.
- The owner's approval and role-layout decisions encoded, not just documented.

**Non-Goals:**
- Publishing to Anthropic's or OpenAI's directories (later, with the license decision).
- Tracker integration (TaskFrame) — later adapter.

## Decisions

1. **MCP server in-process, long work as background jobs.** `src/mcp.ts` uses `@modelcontextprotocol/sdk` (stdio). Quick tools call the CLI functions directly. `devflow_run`, `devflow_gate` and `devflow_roles_propose --probe` start a detached `devflow <command>` job (generalising `startDetached`: any CLI arguments, a task lock for task commands, a project lock for role probing) and return `{ jobId, log }`. Each tool returns JSON text; `DevflowError` → `isError: true` with `reason`.

2. **Project location** (plan review finding 4). Root = `projectDir` argument → `CLAUDE_PROJECT_DIR` → cwd, then upward search for `.devflow/`. A root inside the plugin install directory is rejected. Codex: the `devflow` skill tells the assistant to pass `projectDir` (its working directory) on every call.

3. **Who approves through MCP** (finding 1). In chat the human acts through the assistant; the guarantee we can give is: (a) tool descriptions and the `devflow-approval` skill say approval, rejection and delegation are only on an explicit user instruction; (b) Claude Code asks the user before running an MCP tool unless the user allowed it, and the README tells users never to auto-allow these three; (c) approve/reject name the plan revision (`--revision`), so an approval cannot land on a plan the human has not seen (`plan_moved`). A stronger, out-of-band confirmation is listed as an open question in `docs/TODO.md`.

4. **Delegated review** (findings 2, 3). Role `review` (optional in config; default `design_complex` → `design`), restricted to `claude`/`codex`. The run loop, for a delegated `DESIGNED` task: records `planDigest` and revision, copies the change folder into a temp directory (nothing else), runs the reviewer there read-only with the plan inline; the reviewer's final message (codex `-o`, claude JSON `result`) is captured by devflow, which writes `review.md` itself. Then, under the task lock: if still `DESIGNED`, delegation still `model`, digest and revision unchanged → apply `APPROVE` / `REJECT`; else discard with `review_stale`.

5. **Roles** (finding 7). One cross-vendor ranking (spec). `propose` filters by installed CLIs and, with `--probe`, by real probes through `runRole` with the project's runner settings. Assignment rules and the zero/one-candidate cases are in the spec. `init` presets: no Fable; `design_complex`/`review` = opus (claude) or gpt-6.2-sol (codex only). `set` supports `--command` for `command` runners and writes atomically after validation (finding 8).

6. **Bundling with esbuild** (`scripts/build-plugins.mjs`): entry `src/cli.ts` → `bin/devflow.mjs`, platform node, ESM, all dependencies inlined. Paths that re-invoke devflow (Claude hook, background jobs) use `process.argv[1]` (the running bundle or `dist/src/cli.js`), not a path derived from module location.

7. **Client launch files.** Claude: `.mcp.json` `{ "mcpServers": { "devflow": { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/bin/devflow.mjs", "mcp"] } } }`. Codex: `{ "mcpServers": { "devflow": { "command": "node", "args": ["./bin/devflow.mjs", "mcp"], "cwd": "." } } }` (relative to the plugin dir, the pattern of the bundled OpenAI plugins). Both require `node` ≥ 22 on PATH; the README says so and `devflow doctor` reports the node version (finding 5). Real installs from a path with spaces are part of task 5.2.

8. **Generated plugins are committed** (marketplaces install from git), guarded by a freshness test that rebuilds into a temp dir and compares.

## Impact zone

- `src/mcp.ts`
- `src/roles.ts`
- `src/review.ts`
- `src/stages.ts`
- `src/lifecycle.ts`
- `src/config.ts`
- `src/cli.ts`
- `src/runners.ts`
- `src/background.ts`
- `scripts/**`
- `skills/**`
- `plugins/**`
- `.claude-plugin/**`
- `.agents/plugins/**`
- `package.json`
- `package-lock.json`
- `test/**`
- `README.md`
- `docs/SPEC.md`
- `docs/TODO.md`
- `openspec/changes/add-plugins-mcp/**`

## Test plan

- `test/mcp.test.ts`: spawn `node dist/src/cli.js mcp` with the SDK client over stdio, cwd set to an unrelated folder; list tools; `devflow_start` + `devflow_status` with `projectDir`; `CLAUDE_PROJECT_DIR` fallback; `devflow_approve` on a wrong state and with a stale revision returns errors with the reason; `devflow_run` and `devflow_gate` return a job id quickly (fake agent sleeps) and `devflow_log` shows progress; `devflow_roles_set` writes config.
- `test/roles.test.ts`: propose with only codex / only claude / both; Fable failing a (fake) probe → opus; verify ≠ implement and other vendor when possible; one candidate → `verify_not_independent`; none → `no_models`; preview vs `--apply`; `set` with and without `--command`; invalid set leaves the file unchanged; init presets without Fable.
- `test/review.test.ts` (run loop with fake agent): no delegation → stops for approval; delegated + `APPROVE` → continues to implement with planDigest; `REJECT: x` → back to design with feedback in the next design prompt; garbage → `unreadable_review`; plan edited during review → `review_stale`; revocation → human again; legacy task without the field → human; reviewer cwd contains only the plan; `command` runner rejected for `review`.
- `test/plugins.test.ts`: build into temp dir; skills byte-identical in both plugins; bundle prints version from a clean dir; manifests contain the MCP launch; committed `plugins/**` equal a fresh build; `claude plugin validate` passes when `claude` is installed (skipped otherwise).
- Real checks (5.2): install the Claude plugin from the local marketplace (repo path with spaces copy) and call a devflow tool from a Claude Code session against a separate checkout; same for Codex with `projectDir`; detached run through MCP; record in the journal.

## Risks / Trade-offs

- [Codex `.mcp.json` path semantics unverified] → real install check; fallback helper.
- [Approval via assistant is a convention] → skill wording + journaled; delegation explicit.
- [Bundle size / duplicated runtime in two plugins] → acceptable (single file, few hundred KB).
- [Model names in the ranking drift] → ranking is data; `propose --probe` drops unavailable ones.
