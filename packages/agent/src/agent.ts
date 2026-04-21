// MailAgent: the headless SDK. Per prompt.md §The Agent API the same
// interface is consumed by the web UI (in-process) and by external
// agents (HTTP transport). This module ships the in-process variant;
// the HTTP transport lives in `./http-client.ts`.

import { randomUUID } from "node:crypto";
import {
  CommandBus,
  MailaiError,
  type Command,
  type CommandSource,
  type CommandTypeString,
  type Mutation,
} from "@mailai/core";
import { CommandPayloadSchema } from "./schemas.js";

export interface MailAgentIdentity {
  readonly userId: string;
  readonly displayName: string;
  readonly tenantId: string;
  readonly inboxIds?: readonly string[];
}

export interface MailAgentOptions {
  readonly bus: CommandBus;
  readonly identity: MailAgentIdentity;
  readonly source?: CommandSource;
  readonly sessionId?: string;
  readonly now?: () => number;
}

export interface ApplyInput {
  readonly type: CommandTypeString;
  readonly payload: unknown;
  readonly idempotencyKey?: string;
  readonly inboxId?: string;
}

export interface BatchEntry {
  readonly status: Mutation["status"] | "skipped";
  readonly mutation: Mutation | null;
  readonly error?: { code: string; message: string };
}

export interface BatchResult {
  readonly results: readonly BatchEntry[];
  readonly appliedCount: number;
  readonly failedAt?: number;
  readonly abortedRest: boolean;
}

export class MailAgent {
  private readonly bus: CommandBus;
  private readonly identity: MailAgentIdentity;
  private readonly source: CommandSource;
  private readonly sessionId: string;
  private readonly now: () => number;

  constructor(opts: MailAgentOptions) {
    this.bus = opts.bus;
    this.identity = opts.identity;
    this.source = opts.source ?? "human";
    this.sessionId = opts.sessionId ?? randomUUID();
    this.now = opts.now ?? (() => Date.now());
  }

  whoAmI(): MailAgentIdentity {
    return this.identity;
  }

  async applyCommand(input: ApplyInput): Promise<Mutation> {
    const validated = CommandPayloadSchema.safeParse({ type: input.type, payload: input.payload });
    if (!validated.success) {
      throw new MailaiError("validation_error", validated.error.message);
    }
    const cmd: Command = {
      type: validated.data.type,
      payload: validated.data.payload,
      source: this.source,
      actorId: this.identity.userId,
      timestamp: this.now(),
      sessionId: this.sessionId,
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    };
    return this.bus.dispatch(cmd, input.inboxId !== undefined ? { inboxId: input.inboxId } : {});
  }

  async applyCommands(
    inputs: readonly ApplyInput[],
    opts: { stopOnError?: boolean } = {},
  ): Promise<BatchResult> {
    const stopOnError = opts.stopOnError ?? true;
    const results: BatchEntry[] = [];
    let appliedCount = 0;
    let failedAt: number | undefined;
    let abortedRest = false;
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]!;
      if (abortedRest) {
        results.push({
          status: "skipped",
          mutation: null,
          error: { code: "skipped", message: "previous command failed" },
        });
        continue;
      }
      try {
        const m = await this.applyCommand(input);
        results.push({ status: m.status, mutation: m });
        if (m.status === "applied") appliedCount++;
        if ((m.status === "failed" || m.status === "rolled-back") && failedAt === undefined) {
          failedAt = i;
          if (stopOnError) abortedRest = true;
        }
      } catch (err) {
        const code = err instanceof MailaiError ? err.code : "internal_error";
        const message = err instanceof Error ? err.message : String(err);
        results.push({ status: "failed", mutation: null, error: { code, message } });
        if (failedAt === undefined) failedAt = i;
        if (stopOnError) abortedRest = true;
      }
    }
    return {
      results,
      appliedCount,
      ...(failedAt !== undefined ? { failedAt } : {}),
      abortedRest,
    };
  }

  async getPendingMutations(filter?: { actorId?: string; type?: CommandTypeString }): Promise<Mutation[]> {
    return this.bus.listPending(filter);
  }

  async approveMutation(mutationId: string): Promise<Mutation> {
    return this.bus.approve(mutationId, this.identity.userId);
  }

  async rejectMutation(mutationId: string, reason?: string): Promise<Mutation> {
    if (reason !== undefined) return this.bus.reject(mutationId, reason);
    return this.bus.reject(mutationId);
  }
}
