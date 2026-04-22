// Command bus: the only mutation path in mail-ai.
//
// Architecture invariant (enforced by scripts/check-architecture.mjs +
// reviewed in PR): no overlay-db repository, no imap-sync method, no
// HTTP route may write state outside of a CommandHandler registered
// here. The bus owns audit fan-out and idempotency caching.
//
// History note: this module used to own a staging / approve / reject
// flow that paused agent-source commands until a human approved them
// in /pending. That review surface was removed in the Notion-Mail
// overhaul — every dispatched command now runs its handler eagerly.
// External agents that want a human-in-the-loop must build that on
// their side before they call us.

import { randomUUID } from "node:crypto";
import { MailaiError } from "../errors.js";
import type {
  Command,
  CommandTypeString,
  EntitySnapshot,
  ImapSideEffect,
  Mutation,
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
}

export class InMemoryMutationStore implements MutationStore {
  private readonly map = new Map<string, Mutation>();
  async save(m: Mutation) {
    this.map.set(m.id, m);
  }
  async get(id: string) {
    return this.map.get(id) ?? null;
  }
}

export interface CommandBusOptions {
  readonly store?: MutationStore;
  readonly audit?: AuditSink;
  readonly now?: () => number;
}

export class CommandBus {
  private readonly handlers = new Map<string, CommandHandler>();
  private readonly store: MutationStore;
  private readonly audit?: AuditSink;
  private readonly now: () => number;
  private readonly idempotencyCache = new Map<string, string>();

  private idempotencyId(cmd: Command): string {
    return `${cmd.actorId}|${cmd.type}|${cmd.idempotencyKey}`;
  }

  constructor(opts: CommandBusOptions = {}) {
    this.store = opts.store ?? new InMemoryMutationStore();
    if (opts.audit !== undefined) this.audit = opts.audit;
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

    const id = randomUUID();
    const createdAt = this.now();
    if (cmd.idempotencyKey) this.idempotencyCache.set(this.idempotencyId(cmd), id);

    return this.executeHandler(id, cmd, handler, ctx, createdAt);
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
