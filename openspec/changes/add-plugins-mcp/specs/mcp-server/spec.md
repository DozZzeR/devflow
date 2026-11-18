## Purpose

Defines the MCP interface of devflow: which tools an MCP client (Claude Code, Claude App, Codex, OpenCode) can call, what they return, and how long-running work stays out of tool calls.

## ADDED Requirements

### Requirement: Server and transport

`devflow mcp` SHALL start an MCP server on stdio for the project found from its working directory (or `--dir`). It MUST NOT print anything but protocol messages on stdout.

#### Scenario: Client lists tools

- **WHEN** an MCP client connects and lists tools
- **THEN** it receives the devflow tools with input schemas

### Requirement: Task tools

The server SHALL provide `devflow_status`, `devflow_start`, `devflow_next`, `devflow_gate`, `devflow_approve`, `devflow_reject` and `devflow_delegate_approval`, each mapping to the CLI behaviour of the same name and returning JSON text. Domain errors MUST be returned as tool errors carrying the devflow `reason`, not as protocol failures.

#### Scenario: Out-of-order approval

- **WHEN** a client calls `devflow_approve` for a task that is not awaiting approval
- **THEN** the tool result is an error whose text contains `not_awaiting_approval`

### Requirement: Background runs

`devflow_run` SHALL start the run loop in the background (same lock rules as `devflow run --detach`) and return `{ runId, log }` immediately. `devflow_run_status` SHALL report whether the run is active, its last stage report and the task's next stage; `devflow_log` SHALL return the tail of the run log (default 200 lines).

#### Scenario: Run returns at once

- **WHEN** a client calls `devflow_run` for a task whose stages take minutes
- **THEN** the call returns within seconds with a run id

#### Scenario: Progress

- **WHEN** a client calls `devflow_log` while the run is active
- **THEN** it receives the latest lines written so far

### Requirement: Role tools

The server SHALL provide `devflow_roles` (show), `devflow_roles_propose` and `devflow_roles_set` with the same behaviour as the CLI.

#### Scenario: Set a role

- **WHEN** a client calls `devflow_roles_set` with role `verify`, runner `codex`, model `gpt-6.2-sol`
- **THEN** `.devflow/config.json` has that role and `devflow_roles` shows it
