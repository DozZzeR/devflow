## ADDED Requirements

### Requirement: Focused shell scope in the Claude hook

The hook SHALL allow a Bash command that is not an exact `scope.bash` entry only when `scope.focused` exists and the trimmed command equals the template, with `{files}` replaced by one or more tokens separated by single spaces. Each token MUST match `^[A-Za-z0-9_][A-Za-z0-9_./-]*$`, MUST have no `.` or `..` segment, and MUST match `scope.focused.paths`. At most 64 tokens are allowed. Anything else MUST be denied.

#### Scenario: Focused command with test files allowed
- **WHEN** the scope has focused `{ template: "node scripts/test-focused.mjs {files}", paths: ["test/**"] }` and Bash runs `node scripts/test-focused.mjs test/hook.test.ts test/config.test.ts`
- **THEN** the decision is allow

#### Scenario: Non-test path rejected
- **WHEN** the same scope receives `node scripts/test-focused.mjs src/hook.ts` or `node scripts/test-focused.mjs test/../src/hook.ts`
- **THEN** the decision is deny with a reason that names the shell command

#### Scenario: Extra command rejected
- **WHEN** the same scope receives `node scripts/test-focused.mjs test/hook.test.ts && rm -rf src`, a command with `;`, `|`, a newline, `$(...)`, a quote or a glob character in a token, or a token starting with `-`
- **THEN** the decision is deny

#### Scenario: Empty file list rejected
- **WHEN** the same scope receives `node scripts/test-focused.mjs` with no files
- **THEN** the decision is deny

#### Scenario: Template text is not an allowlist entry
- **WHEN** the scope has a focused entry and Bash runs the raw template `node scripts/test-focused.mjs {files}`
- **THEN** the decision is deny

#### Scenario: No focused entry keeps exact matching
- **WHEN** the scope has no `focused` and `bash: ["npm test"]`
- **THEN** `npm test` is allowed and every other command is denied, as before

### Requirement: Runner passes the focused scope

`RunRequest` SHALL accept an optional `focused` `{ template, paths }`. The Claude runner MUST write it into the scope file and add `Bash(<prefix>:*)` to `--allowedTools`, where `<prefix>` is the trimmed template text before `{files}`. It MUST NOT add `--disallowedTools Bash` when `focused` is set. `validateScope` MUST reject `focused` on a run with an empty write scope.

#### Scenario: Claude invocation with focused scope
- **WHEN** a Claude role runs with write `["src/**"]`, bash `[]` and focused template `node scripts/test-focused.mjs {files}`
- **THEN** the scope file has that `focused` entry, the args contain `Bash(node scripts/test-focused.mjs:*)`, and they do not contain `--disallowedTools`

#### Scenario: Read-only run with focused scope rejected
- **WHEN** `runRole` is called with write `[]` and a `focused` entry
- **THEN** it throws `invalid_scope` before it launches anything
