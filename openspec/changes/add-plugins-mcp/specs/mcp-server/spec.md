## Purpose

Defines the MCP interface of devflow: which tools an MCP client (Claude Code, Claude App, Codex, OpenCode) can call, what they return, how the project is located independently of where the plugin is installed, and how long-running work stays out of tool calls.

## ADDED Requirements

### Requirement: Server and transport

`devflow mcp` SHALL start an MCP server on stdio. It MUST NOT print anything but protocol messages on stdout.

#### Scenario: Client lists tools

- **WHEN** an MCP client connects and lists tools
- **THEN** it receives the devflow tools with input schemas

### Requirement: Project location

Every tool SHALL accept an optional `projectDir`. The project root SHALL be resolved from `projectDir`, else the `CLAUDE_PROJECT_DIR` environment variable, else the server's working directory, by searching upwards for `.devflow/`; the plugin's own install directory MUST NOT be used as a project. A missing project is a tool error with reason `no_project`.

#### Scenario: Codex plugin directory as cwd

- **WHEN** the server runs with its working directory set to the plugin folder and a tool is called with `projectDir` pointing to a checkout
- **THEN** the tool acts on that checkout

### Requirement: Task tools

The server SHALL provide `devflow_status`, `devflow_start`, `devflow_next`, `devflow_approve`, `devflow_reject` and `devflow_delegate_approval`, each mapping to the CLI behaviour of the same name and returning JSON text. Domain errors MUST be returned as tool errors carrying the devflow `reason`. Tools that record a human decision MUST state in their description that they may be called only on the user's explicit instruction.

#### Scenario: Out-of-order approval

- **WHEN** a client calls `devflow_approve` for a task that is not awaiting approval
- **THEN** the tool result is an error whose text contains `not_awaiting_approval`

### Requirement: Background jobs

Tools whose work can take longer than a few seconds (`devflow_run`, `devflow_gate`, `devflow_roles_propose` with probing) SHALL start a background job under the task's or project's lock and return `{ jobId, log }` immediately. `devflow_job_status` SHALL report whether the job is active and its last result line; `devflow_log` SHALL return the tail of a job log (default 200 lines).

#### Scenario: Run returns at once

- **WHEN** a client calls `devflow_run` for a task whose stages take minutes
- **THEN** the call returns within seconds with a job id

#### Scenario: Progress

- **WHEN** a client calls `devflow_log` while the job is active
- **THEN** it receives the latest lines written so far

### Requirement: Role tools

The server SHALL provide `devflow_roles` (show), `devflow_roles_propose` and `devflow_roles_set` with the same behaviour as the CLI.

#### Scenario: Set a role

- **WHEN** a client calls `devflow_roles_set` with role `verify`, runner `codex`, model `gpt-6.2-sol`
- **THEN** `.devflow/config.json` has that role and `devflow_roles` shows it
