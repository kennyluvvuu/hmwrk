/**
 * Domain error type. Tools (A2) turn these into human-readable messages for the agent;
 * the store (D2) and the fakes throw the same errors so behaviour matches in tests.
 */

export type DomainErrorCode =
  | "invalid_date"
  | "invalid_time"
  | "invalid_setting"
  | "invalid_transition"
  | "invalid_argument"
  | "not_found"
  | "conflict";

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DomainError";
    this.code = code;
  }
}

/** Requested entity does not exist. */
export class NotFoundError extends DomainError {
  constructor(message: string) {
    super("not_found", message);
    this.name = "NotFoundError";
  }
}

/** Assignment/verification status change is not allowed from the current state. */
export class InvalidTransitionError extends DomainError {
  constructor(message: string) {
    super("invalid_transition", message);
    this.name = "InvalidTransitionError";
  }
}

/** Date, time or setting value could not be parsed. */
export class InvalidValueError extends DomainError {
  constructor(code: Extract<DomainErrorCode, "invalid_date" | "invalid_time" | "invalid_setting" | "invalid_argument">, message: string) {
    super(code, message);
    this.name = "InvalidValueError";
  }
}

/** Write conflicts with existing state (e.g. duplicate OpenWebUI account). */
export class ConflictError extends DomainError {
  constructor(message: string) {
    super("conflict", message);
    this.name = "ConflictError";
  }
}
