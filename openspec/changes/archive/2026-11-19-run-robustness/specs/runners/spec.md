## ADDED Requirements

### Requirement: Usage-limit detection

After a `claude` or `codex` run with a numeric exit code, the system SHALL set `usageLimit` and `ok: false` when the run ended on a subscription or rate limit. For `claude` (any numeric exit), the last JSON object line has `api_error_status` 429 or `api_error` `usage_limit_reached`. For `codex`, the exit is non-zero and one of the last 50 log lines contains `error` with `usage limit` or a standalone `429`. A null exit MUST NOT count for any runner.

#### Scenario: Claude usage limit

- **WHEN** a `claude` run exits 0 and its log ends with `{"type":"result","is_error":true,"api_error":"usage_limit_reached","result":"5-hour limit reached ∙ resets 5pm"}`
- **THEN** the result has `ok: false` and `usageLimit` with `runner: "claude"` and `reset: "5pm"`

#### Scenario: Claude rate limit without reset

- **WHEN** a `claude` run exits with a number and its last JSON line has `api_error_status: 429` and its text names no reset
- **THEN** the result has `usageLimit` without `reset`

#### Scenario: Killed Claude run is not a limit

- **WHEN** a `claude` run prints a final JSON object with `api_error: "usage_limit_reached"` and is then killed or times out, so its exit code is null
- **THEN** the result has no `usageLimit`

#### Scenario: Codex usage limit

- **WHEN** a `codex` run exits 1 and its last log line is `ERROR: You've hit your usage limit. Try again at 5:00 PM.`
- **THEN** the result has `usageLimit` with `runner: "codex"` and `reset: "5:00 PM"`

#### Scenario: Timed-out Codex run is not a limit

- **WHEN** a `codex` run prints `ERROR: 429` and then times out or is killed, so its exit code is null
- **THEN** the result has no `usageLimit`

#### Scenario: Echoed prompt is not a limit

- **WHEN** a `codex` run exits 1 because of an ordinary error, and the words `usage limit` appear only in the echoed prompt more than 50 lines before the end of the log
- **THEN** the result has no `usageLimit`

#### Scenario: Successful run mentioning 429

- **WHEN** a `codex` run exits 0 and its answer contains `error 429`
- **THEN** the result has no `usageLimit`

#### Scenario: Command runner is never classified

- **WHEN** a `command` runner exits 1 and prints `ERROR: You've hit your usage limit.`
- **THEN** the result has no `usageLimit`

### Requirement: Reset text

The reset SHALL be the text after the first `resets`, `try again at` or `try again in`, up to the line end or `|`, ending at the first word that ends with a period. A dotted abbreviation such as `p.m.` keeps its periods; other such words lose the final one. The text is trimmed and capped at 100 characters. For Codex, the search starts at the first matching line of the error block. A Claude `|<epoch seconds>` suffix SHALL become an ISO UTC time. No reset MUST be invented.

#### Scenario: Epoch reset

- **WHEN** the Claude result text is `Claude AI usage limit reached|1763571600`
- **THEN** `usageLimit.reset` is `2025-11-19T17:00:00.000Z`

#### Scenario: Punctuated reset

- **WHEN** a `codex` run exits 1 with `ERROR: You've hit your usage limit. Try again at 5 p.m.`
- **THEN** `usageLimit.reset` is `5 p.m.`

#### Scenario: Reset on a later line of the error

- **WHEN** a `codex` run exits 1 with `ERROR: You've hit your usage limit.` followed by the line `Upgrade to Pro or try again at 5:00 PM.`
- **THEN** `usageLimit.reset` is `5:00 PM`

#### Scenario: Several matching lines in one error block

- **WHEN** a `codex` run exits 1 with `ERROR: You've hit your usage limit. Try again at 5:00 PM.` directly followed by `ERROR: HTTP 429`
- **THEN** `usageLimit.reset` is `5:00 PM`

#### Scenario: Decimal in the reset

- **WHEN** the limit text says `try again in 2.5 hours.`
- **THEN** `usageLimit.reset` is `2.5 hours`
