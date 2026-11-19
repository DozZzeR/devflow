## ADDED Requirements

### Requirement: Pre-existing changes in the zone gate

For each path the zone gate would list as outside the zone, if the task's dirty snapshot holds that path and its current hash equals the snapshot hash, the gate SHALL NOT count it and SHALL add the warning `preexisting_change:<path>`. An outside-zone snapshot path whose hash differs MUST be listed as outside the zone. So MUST one that has left the change set, for example by being reverted to the base.

#### Scenario: Unchanged human edit

- **WHEN** the zone is `src/**`, `README.md` was dirty at implement start, and the role changed only `src/a.ts`
- **THEN** the zone gate passes with warning `preexisting_change:README.md`

#### Scenario: Role edits a dirty path

- **WHEN** `README.md` was dirty at implement start and the role changed its content
- **THEN** the zone gate fails with `outside_zone` and lists `README.md`

#### Scenario: Role reverts a dirty path

- **WHEN** `README.md` was dirty at implement start and the role restored it to the base content
- **THEN** the zone gate fails with `outside_zone` and lists `README.md`

#### Scenario: Pre-existing deletion kept

- **WHEN** `docs/old.md` was deleted before implement started and is still deleted
- **THEN** the zone gate does not list it and warns `preexisting_change:docs/old.md`

#### Scenario: New path outside the zone

- **WHEN** a dirty snapshot exists and the role creates `notes.txt` outside the zone
- **THEN** the zone gate fails and lists `notes.txt`

#### Scenario: No snapshot

- **WHEN** the task has no dirty snapshot and `README.md` is changed outside the zone
- **THEN** the zone gate fails and lists `README.md`, as before

### Requirement: Full change set for evidence

Pre-existing changes exempted by the zone gate SHALL still belong to the change set used by the evidence snapshot digest, the rollback gate, the verify copy and the trusted-config checks.

#### Scenario: Snapshot covers exempted paths

- **WHEN** `README.md` is exempted as a pre-existing change and changes after gates passed
- **THEN** verify does not run and the task returns to gates with `snapshot_changed`
