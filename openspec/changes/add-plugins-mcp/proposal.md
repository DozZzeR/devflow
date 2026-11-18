# Proposal

## Why

devflow works from a terminal, but the owner works mostly inside Claude Code / Claude App and colleagues may prefer Codex. Today the assistant in those clients has to shell out to `devflow` and parse its output, long runs give no progress, and nothing tells the assistant how to use devflow well. The owner also decided (2026-11-18): plan approval stays with the human unless they explicitly delegate it; `design_complex` should be the strongest available model (Fable only when credits exist); roles can be rebalanced before a project starts or on request, with the launching model allowed to propose a layout.

## What Changes

- **MCP server** `devflow mcp` (stdio): tools for status, start, next, run in the background with run id, run status and log tail, approve / reject, gates, roles show / propose / set. Long work never blocks a tool call.
- **Approval delegation**: `devflow delegate-approval <id> --to model` (and the matching MCP tool) lets a reviewer role approve or reject the plan; without it approval stays human. The reviewer runs on the `review` role (default: strongest available model) with the plan only, and writes `APPROVE` or `REJECT: <reasons>`.
- **Roles**: `devflow roles` shows the role → runner/model table; `devflow roles propose` suggests a layout from the CLIs and models actually available (probing them), with `design_complex` and `review` on the strongest one; `devflow roles set <role> <runner> <model>` changes one role. Presets: `design_complex` defaults to the strongest model that passed a probe, not to Fable.
- **Plugins from one source**: `skills/` holds devflow's skills (how to run a task, how to rebalance roles, how approval works). A build step bundles devflow into a single file and lays out two plugins, `plugins/claude/devflow` (`.claude-plugin/plugin.json`, skills, `.mcp.json`) and `plugins/codex/devflow` (`.codex-plugin/plugin.json`, skills, `.mcp.json`), plus marketplace files so both can be installed from this git repository.

## Capabilities

### New Capabilities

- `mcp-server`: devflow's MCP tools, their inputs and outputs, background behaviour and error mapping.
- `plugins`: the two plugin layouts built from one skill source, bundling, marketplace entries and validation.
- `role-management`: showing, proposing and changing the role → model layout, including the strongest-model rule.

### Modified Capabilities

- `task-lifecycle`: plan approval can be delegated to a reviewer role by an explicit command; default remains human.

## Impact

- New runtime dependency `@modelcontextprotocol/sdk`; new dev dependency `esbuild` (bundling only).
- New `src/mcp.ts`, `src/roles.ts`, `src/review.ts`, `scripts/build-plugins.mjs`, `skills/**`, `plugins/**` (generated, committed so marketplaces can install from git).
- `devflow init` presets change for `design_complex` (no Fable by default).
- Real model calls only in `roles propose --probe`, delegated review and real runs; tests use fakes.
