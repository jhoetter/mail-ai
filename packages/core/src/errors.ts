// Structured error hierarchy. Every layer surfaces typed errors so the
// CLI exit-code mapping (1 user, 2 auth, 3 network, 4 conflict) is
// stable, and so the agent staging UI can render actionable messages
// rather than stack traces.

export type MailaiErrorCode =
  | "user_error"
  | "auth_error"
  | "network_error"
  | "imap_error"
  | "smtp_error"
  | "conflict_error"
  | "not_found"
  | "permission_denied"
  | "validation_error"
  | "internal_error";

export class MailaiError extends Error {
  readonly code: MailaiErrorCode;
  override readonly cause?: unknown;
  readonly meta?: Record<string, unknown>;

  constructor(code: MailaiErrorCode, message: string, opts: { cause?: unknown; meta?: Record<string, unknown> } = {}) {
    super(message);
    this.name = "MailaiError";
    this.code = code;
    if (opts.cause !== undefined) this.cause = opts.cause;
    if (opts.meta !== undefined) this.meta = opts.meta;
  }
}

export function isMailaiError(value: unknown): value is MailaiError {
  return value instanceof MailaiError;
}
