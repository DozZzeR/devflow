# Documenting devflow code

This rule applies when adding, changing or reviewing maintained TypeScript and JavaScript in `src/`, `scripts/` and `test/`, including fixtures. Generated plugin bundles inherit documentation from their source.

- Start each module with a JSDoc `@file` summary of its responsibility. Keep a CLI shebang on the first line.
- Give every named function, method, constructor, class, type, interface, interface member and module-level domain constant a JSDoc contract. Include private and nested named helpers. Document test fixtures and named test helpers in the same way. Give each test case a name that states the observable behavior.
- Describe what a caller can rely on. Document units, optional values, ordering, side effects, persistence, retry behavior, errors and ownership when they affect the contract. Use `@param`, `@returns` and `@throws` when they explain information beyond the TypeScript signature. Use a short local comment for a non-obvious branch or anonymous callback.
- When changing a decision, document who makes it, which evidence and prior state it requires, its possible outcomes and how execution continues after a retry or stop. For changes to roles, statuses, routing, artifact formats or operator commands, update the corresponding section of [the developer guide](../../docs/DEVELOPMENT.md) and the relevant OpenSpec contract in the same change.
- During review, compare changed declarations and behavior with their JSDoc, the guide and the scenario tests. Missing or stale documentation for a changed contract must be corrected before merge.
