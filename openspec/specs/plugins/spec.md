# plugins Specification

## Purpose
Defines how devflow ships as installable plugins for Claude Code and Codex from one source: shared skills, a bundled single-file runtime, MCP configuration per client, and marketplace entries in this repository.

## Requirements

### Requirement: One skill source

Skills SHALL live once in `skills/<name>/SKILL.md` and be copied unchanged into both plugins. At least these skills SHALL exist: `devflow` (running and steering a task), `devflow-roles` (reviewing and rebalancing roles), `devflow-approval` (approval rules and delegation).

#### Scenario: Same skill in both plugins

- **WHEN** the plugins are built
- **THEN** `plugins/claude/devflow/skills/devflow/SKILL.md` and `plugins/codex/devflow/skills/devflow/SKILL.md` are byte-identical to `skills/devflow/SKILL.md`

### Requirement: Bundled runtime

The build SHALL bundle devflow (CLI, MCP server, hook entry) and its runtime dependencies into one file `bin/devflow.mjs` inside each plugin, runnable with `node` and no `npm install`.

#### Scenario: Plugin runs without install

- **WHEN** `node plugins/claude/devflow/bin/devflow.mjs --version` runs in a clean directory
- **THEN** it prints the devflow version

### Requirement: Client manifests

The Claude Code plugin SHALL have `.claude-plugin/plugin.json` and `.mcp.json` starting `node ${CLAUDE_PLUGIN_ROOT}/bin/devflow.mjs mcp`; the Codex plugin SHALL have `.codex-plugin/plugin.json` with `skills` and `mcpServers` entries and an `.mcp.json` that starts the bundled file relative to the plugin directory. The Claude plugin MUST pass `claude plugin validate`.

#### Scenario: Claude validation

- **WHEN** `claude plugin validate plugins/claude/devflow` runs
- **THEN** it reports that validation passed

### Requirement: Marketplaces

The repository SHALL provide `.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json` listing the respective plugin, so each client can add this repository as a marketplace and install devflow.

#### Scenario: Claude marketplace entry

- **WHEN** a user adds this repository as a Claude Code marketplace
- **THEN** a plugin named `devflow` is available to install

### Requirement: Build is reproducible

`npm run build:plugins` SHALL regenerate `plugins/**` from sources; a test SHALL fail when the committed plugins differ from a fresh build.

#### Scenario: Stale plugin

- **WHEN** a skill changes and plugins are not rebuilt
- **THEN** the plugin freshness test fails
