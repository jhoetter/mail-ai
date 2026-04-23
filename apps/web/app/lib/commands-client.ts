// Generic command dispatcher. All mutations from the web UI route
// through /api/commands so the audit log + idempotency cache see them
// regardless of which feature initiated them. Returns the resulting
// Mutation row so callers can react to success/failure.
//
// Important: the bus returns 200 OK with `mutation.status === "failed"`
// when the handler ran but the underlying provider call (Gmail/Graph)
// failed — e.g. missing OAuth credentials, expired token, network
// blip. The web UI does optimistic updates and relies on a thrown
// error to know it has to roll back, so we promote a failed mutation
// to a thrown CommandFailedError. Callers that want to inspect the
// mutation row regardless can catch the error and read `.mutation`.

import { client } from "./api";
import {
  MailaiError,
  type CommandTypeString,
  type MailaiErrorCode,
  type Mutation,
} from "@mailai/core";
import { publishCommandError } from "./command-errors";

const KNOWN_CODES: ReadonlySet<MailaiErrorCode> = new Set<MailaiErrorCode>([
  "user_error",
  "auth_error",
  "network_error",
  "imap_error",
  "smtp_error",
  "conflict_error",
  "not_found",
  "permission_denied",
  "validation_error",
  "internal_error",
]);

function asKnownCode(code: string | undefined): MailaiErrorCode {
  return code && KNOWN_CODES.has(code as MailaiErrorCode)
    ? (code as MailaiErrorCode)
    : "internal_error";
}

export interface CommandInput {
  type: CommandTypeString;
  payload: unknown;
  idempotencyKey?: string;
  inboxId?: string;
}

export class CommandFailedError extends MailaiError {
  readonly mutation: Mutation;
  constructor(mutation: Mutation) {
    const message = mutation.error?.message ?? `command ${mutation.command.type} failed`;
    super(asKnownCode(mutation.error?.code), message);
    this.name = "CommandFailedError";
    this.mutation = mutation;
  }
}

export async function dispatchCommand(input: CommandInput): Promise<Mutation> {
  const m = await client().applyCommand({
    type: input.type,
    payload: input.payload,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.inboxId ? { inboxId: input.inboxId } : {}),
  });
  if (m.status === "failed") {
    const err = new CommandFailedError(m);
    publishCommandError({ commandType: m.command.type, code: err.code, message: err.message });
    throw err;
  }
  return m;
}
