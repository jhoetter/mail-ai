// Generic command dispatcher. All mutations from the web UI route
// through /api/commands so the audit log + idempotency cache see them
// regardless of which feature initiated them. Returns the resulting
// Mutation row so callers can react to success/failure.

import { client } from "./api";
import type { CommandTypeString, Mutation } from "@mailai/core";

export interface CommandInput {
  type: CommandTypeString;
  payload: unknown;
  idempotencyKey?: string;
  inboxId?: string;
}

export async function dispatchCommand(input: CommandInput): Promise<Mutation> {
  return client().applyCommand({
    type: input.type,
    payload: input.payload,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.inboxId ? { inboxId: input.inboxId } : {}),
  });
}
