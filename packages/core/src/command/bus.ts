// Command bus: the only mutation path in mail-ai.
//
// Architecture invariant (enforced by scripts/check-architecture.mjs +
// reviewed in PR): no overlay-db repository, no imap-sync method, no
// HTTP route may write state outside of a CommandHandler registered
// here. The bus owns approval staging, audit fan-out, and the in-memory
// pending queue (durable copy lives in overlay-db.audit_log).

import { randomUUID } from "node:crypto";
import { MailaiError } from "../errors.js";
import { shouldStage, type PolicyOverrides } from "./policy.js";
import type {
  Command,
  CommandTypeString,
  EntitySnapshot,
  ImapSideEffect,
  Mutation,
  MutationStatus,
} from "./types.js";

export interface HandlerContext {
  readonly inboxId?: string;
  readonly nowMs: number;
}

export interface HandlerResult {
  readonly before: readonly EntitySnapshot[];
  readonly after: readonly EntitySnapshot[];
  readonly imapSideEffects?: readonly ImapSideEffect[];
}

export type CommandHandler<TType extends CommandTypeString = CommandTypeString, TPayload = unknown> = (
  cmd: Command<TType, TPayload>,
  ctx: HandlerContext,
) => Promise<HandlerResult>;

export type AuditSink = (mutation: Mutation) => Promise<void> | void;

export interface MutationStore {
  save(mutation: Mutation): Promise<void>;
  get(id: string): Promise<Mutation | null>;
  listPending(filter?: { actorId?: string; type?: CommandTypeString }): Promise<Mutation[]>;
  update(id: string, patch: Partial<Mutation>): Promise<Mutation>;
}

export class InMemoryMutationStore implements MutationStore {
  private readonly map = new Map<string, Mutation>();
  async save(m: Mutation) {
    this.map.set(m.id, m);
  }
  async get(id: string) {
    return this.map.get(id) ?? null;
  }
  async listPending(filter?: { actorId?: string; type?: CommandTypeString }) {
    const all = Array.from(this.map.values()).filter((m) => m.status === "pending");
    return all.filter(
      (m) =>
        (!filter?.actorId || m.command.actorId === filter.actorId) &&
        (!filter?.type || m.command.type === filter.type),
    );
  }
  async update(id: string, patch: Partial<Mutation>) {
    const cur = this.map.get(id);
    if (!cur) throw new MailaiError("not_found", `mutation ${id} not found`);
    const next = { ...cur, ...patch } as Mutation;
    this.map.set(id, next);
    return next;
  }
}

export interface CommandBusOptions {
  readonly store?: MutationStore;
  readonly audit?: AuditSink;
  readonly overrides?: PolicyOverrides;
  readonly now?: () => number;
}

export class CommandBus {
  private readonly handlers = new Map<string, CommandHandler>();
  private readonly store: MutationStore;
  private readonly audit?: AuditSink;
  private readonly overrides: PolicyOverrides;
  private readonly now: () => number;
  private readonly idempotencyCache = new Map<string, string>();

  private idempotencyId(cmd: Command): string {
    return `${cmd.actorId}|${cmd.type}|${cmd.idempotencyKey}`;
  }

  constructor(opts: CommandBusOptions = {}) {
    this.store = opts.store ?? new InMemoryMutationStore();
    if (opts.audit !== undefined) this.audit = opts.audit;
    this.overrides = opts.overrides ?? {};
    this.now = opts.now ?? (() => Date.now());
  }

  register<T extends CommandTypeString, P>(type: T, handler: CommandHandler<T, P>): void {
    if (this.handlers.has(type)) {
      throw new MailaiError("internal_error", `duplicate handler for ${type}`);
    }
    this.handlers.set(type, handler as CommandHandler);
  }

  registered(): CommandTypeString[] {
    return Array.from(this.handlers.keys()) as CommandTypeString[];
  }

  async dispatch(cmd: Command, ctx: { inboxId?: string } = {}): Promise<Mutation> {
    const handler = this.handlers.get(cmd.type);
    if (!handler) {
      throw new MailaiError("validation_error", `no handler for command "${cmd.type}"`);
    }

    if (cmd.idempotencyKey) {
      const existing = this.idempotencyCache.get(this.idempotencyId(cmd));
      if (existing) {
        const cached = await this.store.get(existing);
        if (cached) return cached;
      }
    }

    const stage = shouldStage(cmd, this.overrides, ctx.inboxId);
    const id = randomUUID();
    const createdAt = this.now();
    if (cmd.idempotencyKey) this.idempotencyCache.set(this.idempotencyId(cmd), id);

    if (stage) {
      // Staged mutations do NOT execute the handler. They store the
      // command and the projection is computed by overlaying pending
      // diffs over authoritative state in the agent SDK.
      const m: Mutation = {
        id,
        command: cmd,
        before: [],
        after: [],
        diffs: [],
        imapSideEffects: [],
        status: "pending",
        createdAt,
      };
      await this.store.save(m);
      await this.audit?.(m);
      return m;
    }

    return this.executeHandler(id, cmd, handler, ctx, createdAt);
  }

  async approve(mutationId: string, approvedBy: string): Promise<Mutation> {
    const m = await this.store.get(mutationId);
    if (!m) throw new MailaiError("not_found", `mutation ${mutationId} not found`);
    if (m.status !== "pending") {
      throw new MailaiError("conflict_error", `mutation ${mutationId} is ${m.status}, not pending`);
    }
    const handler = this.handlers.get(m.command.type);
    if (!handler) throw new MailaiError("validation_error", `no handler for ${m.command.type}`);
    const executed = await this.executeHandler(m.id, m.command, handler, {}, this.now());
    return this.store.update(m.id, {
      ...executed,
      approvedBy,
      approvedAt: this.now(),
    });
  }

  async reject(mutationId: string, reason?: string): Promise<Mutation> {
    const m = await this.store.get(mutationId);
    if (!m) throw new MailaiError("not_found", `mutation ${mutationId} not found`);
    if (m.status !== "pending") {
      throw new MailaiError("conflict_error", `mutation ${mutationId} is ${m.status}, not pending`);
    }
    const updated = await this.store.update(mutationId, {
      status: "rejected" as MutationStatus,
      ...(reason !== undefined ? { rejectedReason: reason } : {}),
    });
    await this.audit?.(updated);
    return updated;
  }

  listPending(filter?: { actorId?: string; type?: CommandTypeString }): Promise<Mutation[]> {
    return this.store.listPending(filter);
  }

  getMutation(id: string): Promise<Mutation | null> {
    return this.store.get(id);
  }

  private async executeHandler(
    id: string,
    cmd: Command,
    handler: CommandHandler,
    ctx: { inboxId?: string },
    createdAt: number,
  ): Promise<Mutation> {
    try {
      const result = await handler(cmd, { nowMs: this.now(), ...(ctx.inboxId ? { inboxId: ctx.inboxId } : {}) });
      const diffs = result.before.map((b, i) => {
        const a = result.after[i];
        if (!a) {
          throw new MailaiError("internal_error", "handler returned mismatched before/after lengths");
        }
        return { kind: a.kind, id: a.id, ops: shallowDiffOps(b.data, a.data) };
      });
      const m: Mutation = {
        id,
        command: cmd,
        before: result.before,
        after: result.after,
        diffs,
        imapSideEffects: result.imapSideEffects ?? [],
        status: "applied",
        createdAt,
      };
      await this.store.save(m);
      await this.audit?.(m);
      return m;
    } catch (err) {
      const code = err instanceof MailaiError ? err.code : "internal_error";
      const message = err instanceof Error ? err.message : String(err);
      const m: Mutation = {
        id,
        command: cmd,
        before: [],
        after: [],
        diffs: [],
        imapSideEffects: [],
        status: "failed",
        error: { code, message },
        createdAt,
      };
      await this.store.save(m);
      await this.audit?.(m);
      return m;
    }
  }
}

function shallowDiffOps(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
) {
  const ops: { op: "set" | "unset"; path: string; value?: unknown }[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (Object.is(before[k], after[k])) continue;
    if (after[k] === undefined) ops.push({ op: "unset", path: k });
    else ops.push({ op: "set", path: k, value: after[k] });
  }
  return ops as never;
}
