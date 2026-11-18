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

1. **MCP server in-process, background work via the existing detached runner.** `src/mcp.ts` uses `@modelcontextprotocol/sdk` (stdio). Tools call the same functions as the CLI (`runLoop` is never awaited inside a tool; `devflow_run` calls `startDetached`). Each tool returns `content: [{ type: "text", text: JSON }]`; `DevflowError` → `isError: true` with `reason`.

2. **Who approves through MCP.** In a chat client the human acts through the assistant, so `devflow_approve` / `devflow_reject` called by the assistant on the user's instruction count as human approval. The skill `devflow-approval` tells the assistant to call them only on an explicit user instruction and never on its own judgement; delegation to a model is a separate, explicit tool. This is a convention we cannot enforce technically; documented as such.

3. **Delegated review.** New role `review` (config optional; defaults to `design_complex` → `design`). When a delegated task is `DESIGNED`, the run loop runs the reviewer with the plan files inline, read-only, writing `.devflow/runs/<id>/review.md`; first line `APPROVE` → same path as `devflow approve` (design checks, digest, zone); `REJECT: …` → `reject` with that reason. Anything else → stop for a human with `unreadable_review`. Task state gets `approval: "human" | "model"` (default human).

4. **Roles.** `src/roles.ts`: ranked known models per runner (claude: fable, opus, sonnet, haiku; codex: gpt-6.2-sol, gpt-5.6-terra, gpt-5.6-luna). `propose` filters by installed CLIs and, with `--probe`, by `doctor`-style probes; assigns: design_complex/review = strongest; design = strongest non-Fable (cost); implement/small = mid; explore = cheapest; verify = best model ≠ implement, preferring the other vendor when both CLIs exist. `set` edits the JSON and re-validates before writing (atomic write). `init` presets: `design_complex` = opus for claude/mixed (Fable only via propose/set).

5. **Bundling with esbuild** (`scripts/build-plugins.mjs`): entry `src/cli.ts` → `bin/devflow.mjs`, platform node, format esm, all deps inlined. The runner's hook command and the background runner use `process.argv[1]`-relative resolution so they work from the bundle (today they derive `cli.js` from `import.meta.url`; the bundle exports the same path because the bundle *is* the CLI).

6. **Codex MCP launch.** `.mcp.json`: `{ "mcpServers": { "devflow": { "command": "node", "args": ["./bin/devflow.mjs", "mcp"], "cwd": "." } } }` — relative to the plugin directory, matching the bundled OpenAI plugins' pattern. To verify on the real Codex install (task 5.2); fallback is an absolute path written by a small `devflow plugin install-codex` helper.

7. **Generated plugins are committed** (marketplaces install from git), guarded by a freshness test that rebuilds into a temp dir and compares.

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

- `test/mcp.test.ts`: spawn `node dist/src/cli.js mcp` with the SDK client over stdio; list tools; `devflow_start` + `devflow_status`; `devflow_approve` on a wrong state returns an error with the reason; `devflow_run` returns a run id quickly (fake agent sleeps) and `devflow_log` shows progress; `devflow_roles_set` writes config.
- `test/roles.test.ts`: propose with only codex / only claude / both; Fable failing a (fake) probe → opus; verify ≠ implement; preview vs `--apply`; `set` validation failure leaves file unchanged.
- `test/review.test.ts` (run loop with fake agent): no delegation → stops for approval; delegated + `APPROVE` → continues to implement with planDigest; `REJECT: x` → back to design with feedback in the next design prompt; garbage → `unreadable_review`.
- `test/plugins.test.ts`: build into temp dir; skills byte-identical in both plugins; bundle prints version from a clean dir; manifests contain the MCP launch; committed `plugins/**` equal a fresh build; `claude plugin validate` passes when `claude` is installed (skipped otherwise).
- Real checks (5.2): install the Claude plugin from the local marketplace and call a devflow tool from a Claude Code session; same for Codex; record in the journal.

## Risks / Trade-offs

- [Codex `.mcp.json` path semantics unverified] → real install check; fallback helper.
- [Approval via assistant is a convention] → skill wording + journaled; delegation explicit.
- [Bundle size / duplicated runtime in two plugins] → acceptable (single file, few hundred KB).
- [Model names in the ranking drift] → ranking is data; `propose --probe` drops unavailable ones.
