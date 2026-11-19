/** @file Represent domain failures and CLI usage errors at command boundaries. */

/** A domain error: something the user did or the project state does not allow. Exit code 1. */
export class DevflowError extends Error {
  /** Associate a machine-readable reason and optional details with a human-readable failure. */
  constructor(
    readonly reason: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "DevflowError";
  }
}

/** A command-line usage error. Exit code 2. */
export class UsageError extends Error {
  /** Stable error reason returned for an invalid CLI invocation. */
  readonly reason = "usage";
  /** Represent malformed command syntax so the CLI can return its usage exit code. */
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
