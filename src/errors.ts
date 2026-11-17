/** A domain error: something the user did or the project state does not allow. Exit code 1. */
export class DevflowError extends Error {
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
  readonly reason = "usage";
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
