devflow is a local, single-user tool.

Threat model:
- Anyone who can write to the repository or to `.devflow/` is outside the threat model.
- In scope: the model roles (explore, design, implement, verify, review), the environment they run in (write scope, worktree, environment variables, processes), and their outputs (files, verdicts, logs) as devflow consumes them.
- Findings about attackers outside this scope are low.
