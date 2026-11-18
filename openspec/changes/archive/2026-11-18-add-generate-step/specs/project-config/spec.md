## ADDED Requirements

### Requirement: Build settings

The configuration SHALL accept an optional, strictly validated `build` section with `build.generate` (a non-empty command) and `build.outputs` (project-relative globs). An explicit `build.outputs`, even `[]`, MUST be rejected without `build.generate`. After stripping leading `./` segments, a glob MUST be rejected if it is empty, absolute, has a backslash or `..` segment, or starts with `.devflow`. A config without `build` SHALL behave as before.

#### Scenario: Build section accepted

- **WHEN** the config contains `"build": { "generate": "npm run build:plugins", "outputs": ["plugins/**"] }`
- **THEN** it loads and reports that command and those globs

#### Scenario: Leading ./ segments accepted

- **WHEN** `build.generate` is set and `build.outputs` is `["././plugins/**"]`
- **THEN** it loads and reports the glob as written

#### Scenario: No build section

- **WHEN** the config has no `build` field
- **THEN** it loads, and no generate step runs anywhere

#### Scenario: Unsafe output glob

- **WHEN** `build.outputs` contains `../x/**`, `.devflow/**`, `.devflow-cache/**`, `.devflow*/**` or `./.devflow/runs/**`
- **THEN** commands exit non-zero naming `build.outputs`

#### Scenario: Outputs without command

- **WHEN** `build.outputs` is `["plugins/**"]` and `build.generate` is absent
- **THEN** commands exit non-zero naming `build.generate`

#### Scenario: Empty outputs without command

- **WHEN** the config contains `"build": { "outputs": [] }`
- **THEN** commands exit non-zero naming `build.generate`

#### Scenario: Unknown build field

- **WHEN** the config contains `"build": { "watch": true }`
- **THEN** commands exit non-zero naming `build.watch` as unknown
