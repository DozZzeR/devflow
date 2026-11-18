---
description: "Use when writing, reviewing, or refactoring JavaScript/TypeScript code. Applies SOLID principles pragmatically: improve modularity, testability, and extensibility without over-engineering."
applyTo: "**/*.{js,jsx,ts,tsx,php,go}"
---

# SOLID Principles — Pragmatic Agent Instructions

Use SOLID as guidance, not dogma. Prefer simple, readable code. Add abstraction only when it clearly reduces duplication, isolates change, or improves testability.

## Core Rule

Before changing code, identify:
- what responsibility this module/function has;
- what is likely to change;
- what should stay stable;
- whether the change can be added without rewriting unrelated code.

Avoid large rewrites unless explicitly requested.

---

## S — Single Responsibility Principle

Each function, class, hook, component, or service should have one clear reason to change.

### Prefer
Separate business logic from side effects, rendering, API calls, validation, persistence, and formatting.

```js
function calculateTotal(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}

function renderTotal(total) {
  document.getElementById("total").textContent = total;
}

```

### Avoid

Mixing computation and UI mutation in the same function.

```js
function calculateAndRender(items) {
  const total = items.reduce((sum, item) => sum + item.price, 0);
  document.getElementById("total").textContent = total;
}

```

### Agent behavior

When a file does too many things, split only the part directly related to the task. Do not perform unrelated “cleanup crusades”.

---

## O — Open/Closed Principle

Code should be open for extension but closed for unnecessary modification.

### Prefer

Use maps, configuration objects, callbacks, strategy objects, or small handlers when adding new cases.

```js
const paymentHandlers = {
  card: payByCard,
  paypal: payByPaypal,
  crypto: payByCrypto,
};

function pay(type, data) {
  return paymentHandlers[type](data);
}

```

### Avoid

Growing conditional chains every time a new case appears (when scaling beyond 3-4 cases).

```js
function pay(type, data) {
  if (type === "card") return payByCard(data);
  if (type === "paypal") return payByPaypal(data);
  if (type === "crypto") return payByCrypto(data);
  if (type === "applepay") return payByApplePay(data);
  if (type === "stripe") return payByStripe(data); // Avoid endless branching growth
}

```

### Agent behavior

When adding a new variant, prefer extending configuration or handlers instead of editing central branching logic. But do not introduce strategy/factory abstractions for two trivial cases unless future growth is obvious.

---

## L — Liskov Substitution Principle

A subtype, implementation, or replacement module must preserve the expected behavior of the original contract.

### Prefer

Keep shared interfaces and return types consistent.

```ts
interface Storage { save(file: File): { success: boolean; path: string }; }

class S3Storage implements Storage {
  save(file: File) {
    return { success: true, path: `s3://${file.name}` };
  }
}

```

### Avoid

Returning incompatible shapes, changing expected behavior silently, or throwing unexpected errors.

```ts
class BrokenStorage implements Storage {
  save(file: File) {
    return true; // Violation: Breaks the expected return shape contract
  }
}

```

### Agent behavior

When replacing an implementation, preserve input/output shape, errors, async behavior, null handling, and side effects unless the task explicitly changes the contract.

---

## I — Interface Segregation Principle

Do not force consumers to depend on fields or methods they do not use.

### Prefer

Small focused props, DTOs, hooks, interfaces, and services.

```ts
type UserPreview = {
  id: string;
  name: string;
};

function UserCard({ user }: { user: UserPreview }) {
  return <div>{user.name}</div>;
}

```

### Avoid

Passing huge objects when only one or two fields are needed.

```ts
function UserCard({ user }: { user: FullUserWithPermissionsAndSettings }) {
  return <div>{user.name}</div>;
}

```

### Agent behavior

When adding parameters, avoid bloating existing interfaces. Prefer smaller types, explicit props, or narrow helper functions.

---

## D — Dependency Inversion Principle

High-level logic should depend on abstractions or injected dependencies, not hardcoded low-level details.

### Prefer

Inject API clients, repositories, storage, logger, clock, or config when it improves testing or separation.

```js
function createUserService(userRepository) {
  return {
    async getUser(id) {
      return userRepository.findById(id);
    },
  };
}

```

### Avoid

Hardcoding infrastructure inside business logic.

```js
async function getUser(id) {
  return fetch(`/api/users/${id}`).then(r => r.json()); // Hardcoded global fetch
}

```

### Agent behavior

When code mixes business rules with HTTP, database, filesystem, date/time, or global state, extract the boundary if it helps the current task. Do not build a full architecture cathedral for a tiny script.

---

## Practical Refactoring Rules

### Prefer

* small pure functions;
* explicit names;
* narrow modules;
* composition over inheritance;
* configuration over duplicated branches;
* dependency injection where tests or boundaries benefit;
* preserving existing public contracts;
* minimal diffs.

### Avoid

* god files;
* god components;
* hidden side effects;
* hardcoded infrastructure inside domain logic;
* premature factories/managers/providers;
* abstract classes/interfaces with only one unclear implementation;
* changing unrelated behavior during refactoring.

---

## Agent Checklist

Before finalizing a change, verify:

1. Does each changed function/module have a clear responsibility?
2. Can a new similar case be added without editing unrelated code?
3. Did I preserve existing contracts and return shapes?
4. Are consumers depending only on what they actually need?
5. Are external dependencies isolated enough for testing?
6. Is the abstraction worth its cost?
7. Is the diff minimal and related to the requested task?

If a SOLID rule conflicts with simplicity, choose the simpler design and explain why.

## When to bend the rules

* Tiny scripts or one-off utilities: SRP and DIP overhead may not pay off.
* Performance-critical hot paths: inlining may be justified over abstraction.
* Prototyping: move fast, refactor later. Mark with `// TODO: refactor for SRP` so it's tracked.

## Confirmation

After applying any SOLID principle during code generation or refactoring, mention in the chat which principle(s) were applied and where
