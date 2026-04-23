// CommandBus handlers for thread:snooze / unsnooze / mark-done / reopen.
//
// The "until" payload accepts an ISO timestamp or one of a small set
// of relative shorthands so the CLI can pass "tomorrow" without
// having to know the user's timezone. Resolution happens on the
// server (UTC for v1; user-tz aware once Phase 6 ships timezone
// preferences).

import type { CommandHandler, EntitySnapshot, HandlerResult } from "@mailai/core";
import { MailaiError } from "@mailai/core";
import {
  OauthMessagesRepository,
  OauthThreadStateRepository,
  withTenant,
  type Database,
  type Pool,
} from "@mailai/overlay-db";

export interface ThreadStateDeps {
  readonly pool: Pool;
  readonly tenantId: string;
}

interface SnoozePayload {
  providerThreadId: string;
  until: string;
}

interface ThreadIdPayload {
  providerThreadId: string;
}

export function buildThreadSnoozeHandler(
  deps: ThreadStateDeps,
): CommandHandler<"thread:snooze", SnoozePayload> {
  return async (cmd) => {
    const { providerThreadId, until } = cmd.payload;
    const date = parseUntil(until);
    if (!date) {
      throw new MailaiError(
        "validation_error",
        `unrecognized snooze deadline ${JSON.stringify(until)}`,
      );
    }
    return withTenant(deps.pool, deps.tenantId, async (tx) => {
      await ensureThreadExists(tx, deps.tenantId, providerThreadId);
      const repo = new OauthThreadStateRepository(tx);
      const before = await repo.get(deps.tenantId, cmd.actorId, providerThreadId);
      await repo.snooze(deps.tenantId, cmd.actorId, providerThreadId, date);
      const after = await repo.get(deps.tenantId, cmd.actorId, providerThreadId);
      return snapshot(providerThreadId, before, after);
    });
  };
}

export function buildThreadUnsnoozeHandler(
  deps: ThreadStateDeps,
): CommandHandler<"thread:unsnooze", ThreadIdPayload> {
  return async (cmd) => {
    return withTenant(deps.pool, deps.tenantId, async (tx) => {
      await ensureThreadExists(tx, deps.tenantId, cmd.payload.providerThreadId);
      const repo = new OauthThreadStateRepository(tx);
      const before = await repo.get(deps.tenantId, cmd.actorId, cmd.payload.providerThreadId);
      await repo.unsnooze(deps.tenantId, cmd.actorId, cmd.payload.providerThreadId);
      const after = await repo.get(deps.tenantId, cmd.actorId, cmd.payload.providerThreadId);
      return snapshot(cmd.payload.providerThreadId, before, after);
    });
  };
}

export function buildThreadMarkDoneHandler(
  deps: ThreadStateDeps,
): CommandHandler<"thread:mark-done", ThreadIdPayload> {
  return async (cmd) => {
    return withTenant(deps.pool, deps.tenantId, async (tx) => {
      await ensureThreadExists(tx, deps.tenantId, cmd.payload.providerThreadId);
      const repo = new OauthThreadStateRepository(tx);
      const before = await repo.get(deps.tenantId, cmd.actorId, cmd.payload.providerThreadId);
      await repo.markDone(deps.tenantId, cmd.actorId, cmd.payload.providerThreadId);
      const after = await repo.get(deps.tenantId, cmd.actorId, cmd.payload.providerThreadId);
      return snapshot(cmd.payload.providerThreadId, before, after);
    });
  };
}

export function buildThreadReopenHandler(
  deps: ThreadStateDeps,
): CommandHandler<"thread:reopen", ThreadIdPayload> {
  return async (cmd) => {
    return withTenant(deps.pool, deps.tenantId, async (tx) => {
      await ensureThreadExists(tx, deps.tenantId, cmd.payload.providerThreadId);
      const repo = new OauthThreadStateRepository(tx);
      const before = await repo.get(deps.tenantId, cmd.actorId, cmd.payload.providerThreadId);
      await repo.reopen(deps.tenantId, cmd.actorId, cmd.payload.providerThreadId);
      const after = await repo.get(deps.tenantId, cmd.actorId, cmd.payload.providerThreadId);
      return snapshot(cmd.payload.providerThreadId, before, after);
    });
  };
}

async function ensureThreadExists(
  tx: Database,
  tenantId: string,
  providerThreadId: string,
): Promise<void> {
  const messages = new OauthMessagesRepository(tx);
  const list = await messages.listByProviderThread(tenantId, providerThreadId);
  if (list.length === 0) {
    throw new MailaiError("not_found", `thread ${providerThreadId} not found in oauth_messages`);
  }
}

function parseUntil(input: string): Date | null {
  const trimmed = input.trim().toLowerCase();
  const now = new Date();
  if (trimmed === "today") {
    // 6pm local-server today; for v1 we pin UTC since the dev stack
    // doesn't ship a user-tz preference.
    const d = new Date(now);
    d.setUTCHours(18, 0, 0, 0);
    if (d.getTime() <= now.getTime()) d.setUTCDate(d.getUTCDate() + 1);
    return d;
  }
  if (trimmed === "tomorrow") {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(8, 0, 0, 0);
    return d;
  }
  if (trimmed === "weekend" || trimmed === "this-weekend") {
    const d = new Date(now);
    const day = d.getUTCDay();
    const offset = (6 - day + 7) % 7 || 7;
    d.setUTCDate(d.getUTCDate() + offset);
    d.setUTCHours(8, 0, 0, 0);
    return d;
  }
  if (trimmed === "next-week") {
    const d = new Date(now);
    const day = d.getUTCDay();
    const offset = (1 - day + 7) % 7 || 7;
    d.setUTCDate(d.getUTCDate() + offset);
    d.setUTCHours(8, 0, 0, 0);
    return d;
  }
  const parsed = new Date(input);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  return null;
}

function snapshot(
  providerThreadId: string,
  before: { status: string; snoozedUntil: Date | null; doneAt: Date | null } | null,
  after: { status: string; snoozedUntil: Date | null; doneAt: Date | null } | null,
): HandlerResult {
  const beforeSnap: EntitySnapshot = {
    kind: "thread-state",
    id: providerThreadId,
    version: before ? 1 : 0,
    data: before
      ? {
          status: before.status,
          snoozedUntil: before.snoozedUntil ? before.snoozedUntil.toISOString() : null,
          doneAt: before.doneAt ? before.doneAt.toISOString() : null,
        }
      : { status: "open" },
  };
  const afterSnap: EntitySnapshot = {
    kind: "thread-state",
    id: providerThreadId,
    version: after ? 2 : 0,
    data: after
      ? {
          status: after.status,
          snoozedUntil: after.snoozedUntil ? after.snoozedUntil.toISOString() : null,
          doneAt: after.doneAt ? after.doneAt.toISOString() : null,
        }
      : { status: "open" },
  };
  return { before: [beforeSnap], after: [afterSnap], imapSideEffects: [] };
}
