// CommandBus handlers for draft:create / draft:update / draft:delete /
// draft:send.
//
// Drafts are overlay-only: we never round-trip them to the provider's
// Drafts folder. On send we dispatch a real mail:send (or mail:reply
// when the draft is anchored to a thread) and delete the row in the
// same transaction so the user never sees a "stuck" draft.

import type {
  Command,
  CommandBus,
  CommandHandler,
  EntitySnapshot,
  HandlerResult,
} from "@mailai/core";
import { MailaiError } from "@mailai/core";
import { DraftsRepository, withTenant, type DraftRow, type Pool } from "@mailai/overlay-db";

export interface DraftHandlerDeps {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly bus: CommandBus;
}

interface CreatePayload {
  accountId?: string;
  replyToMessageId?: string;
  providerThreadId?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
}

interface UpdatePayload {
  id: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
  /** ISO-8601 timestamp or null to clear scheduled send. */
  scheduledSendAt?: string | null;
}

interface ScheduleSendPayload {
  draftId: string;
  sendAt: string;
}

interface IdPayload {
  id: string;
  requestReadReceipt?: boolean;
}

export function buildDraftCreateHandler(
  base: DraftHandlerDeps,
): CommandHandler<"draft:create", CreatePayload> {
  return async (cmd, hx) => {
    const deps = { ...base, tenantId: hx.tenantId ?? base.tenantId };
    return withTenant(deps.pool, deps.tenantId, async (tx) => {
      const repo = new DraftsRepository(tx);
      const row = await repo.create({
        tenantId: deps.tenantId,
        userId: cmd.actorId,
        ...(cmd.payload.accountId ? { oauthAccountId: cmd.payload.accountId } : {}),
        ...(cmd.payload.replyToMessageId ? { replyToMessageId: cmd.payload.replyToMessageId } : {}),
        ...(cmd.payload.providerThreadId ? { providerThreadId: cmd.payload.providerThreadId } : {}),
        ...(cmd.payload.to ? { to: cmd.payload.to } : {}),
        ...(cmd.payload.cc ? { cc: cmd.payload.cc } : {}),
        ...(cmd.payload.bcc ? { bcc: cmd.payload.bcc } : {}),
        ...(cmd.payload.subject !== undefined ? { subject: cmd.payload.subject } : {}),
        ...(cmd.payload.bodyText !== undefined ? { bodyText: cmd.payload.bodyText } : {}),
        ...(cmd.payload.bodyHtml !== undefined ? { bodyHtml: cmd.payload.bodyHtml } : {}),
      });
      return wrap(row, /*isCreate*/ true);
    });
  };
}

export function buildDraftUpdateHandler(
  base: DraftHandlerDeps,
): CommandHandler<"draft:update", UpdatePayload> {
  return async (cmd, hx) => {
    const deps = { ...base, tenantId: hx.tenantId ?? base.tenantId };
    return withTenant(deps.pool, deps.tenantId, async (tx) => {
      const repo = new DraftsRepository(tx);
      const before = await repo.byId(deps.tenantId, cmd.actorId, cmd.payload.id);
      if (!before) {
        throw new MailaiError("not_found", `draft ${cmd.payload.id} not found`);
      }
      const updated = await repo.update(deps.tenantId, cmd.actorId, cmd.payload.id, {
        ...(cmd.payload.to !== undefined ? { to: cmd.payload.to } : {}),
        ...(cmd.payload.cc !== undefined ? { cc: cmd.payload.cc } : {}),
        ...(cmd.payload.bcc !== undefined ? { bcc: cmd.payload.bcc } : {}),
        ...(cmd.payload.subject !== undefined ? { subject: cmd.payload.subject } : {}),
        ...(cmd.payload.bodyText !== undefined ? { bodyText: cmd.payload.bodyText } : {}),
        ...(cmd.payload.bodyHtml !== undefined ? { bodyHtml: cmd.payload.bodyHtml } : {}),
        ...(cmd.payload.scheduledSendAt !== undefined
          ? {
              scheduledSendAt:
                cmd.payload.scheduledSendAt === null
                  ? null
                  : new Date(cmd.payload.scheduledSendAt),
            }
          : {}),
      });
      return diff(before, updated);
    });
  };
}

export function buildMailScheduleSendHandler(
  base: DraftHandlerDeps,
): CommandHandler<"mail:schedule-send", ScheduleSendPayload> {
  return async (cmd, hx) => {
    const deps = { ...base, tenantId: hx.tenantId ?? base.tenantId };
    const when = new Date(cmd.payload.sendAt);
    if (Number.isNaN(when.getTime())) {
      throw new MailaiError("validation_error", "invalid sendAt");
    }
    return withTenant(deps.pool, deps.tenantId, async (tx) => {
      const repo = new DraftsRepository(tx);
      const before = await repo.byId(deps.tenantId, cmd.actorId, cmd.payload.draftId);
      if (!before) {
        throw new MailaiError("not_found", `draft ${cmd.payload.draftId} not found`);
      }
      const updated = await repo.update(deps.tenantId, cmd.actorId, cmd.payload.draftId, {
        scheduledSendAt: when,
      });
      return diff(before, updated);
    });
  };
}

export function buildDraftDeleteHandler(
  base: DraftHandlerDeps,
): CommandHandler<"draft:delete", IdPayload> {
  return async (cmd, hx) => {
    const deps = { ...base, tenantId: hx.tenantId ?? base.tenantId };
    return withTenant(deps.pool, deps.tenantId, async (tx) => {
      const repo = new DraftsRepository(tx);
      const before = await repo.byId(deps.tenantId, cmd.actorId, cmd.payload.id);
      if (!before) {
        // Idempotent: deleting a missing draft is a no-op.
        return diff(null, null, cmd.payload.id);
      }
      await repo.delete(deps.tenantId, cmd.actorId, cmd.payload.id);
      return diff(before, null);
    });
  };
}

// draft:send dispatches the appropriate mail:send / mail:reply through
// the bus so the audit log + idempotency cache pick up the actual
// network mutation, then deletes the draft row.
export function buildDraftSendHandler(
  base: DraftHandlerDeps,
): CommandHandler<"draft:send", IdPayload> {
  return async (cmd, hx) => {
    const deps = { ...base, tenantId: hx.tenantId ?? base.tenantId };
    const draft = await withTenant(deps.pool, deps.tenantId, (tx) => {
      const repo = new DraftsRepository(tx);
      return repo.byId(deps.tenantId, cmd.actorId, cmd.payload.id);
    });
    if (!draft) {
      throw new MailaiError("not_found", `draft ${cmd.payload.id} not found`);
    }
    const body = draft.bodyText ?? stripHtml(draft.bodyHtml ?? "");
    const readRcpt = cmd.payload.requestReadReceipt === true;
    if (draft.replyToMessageId) {
      const reply: Command = {
        type: "mail:reply",
        payload: {
          threadId: draft.replyToMessageId,
          body,
          ...(draft.bodyHtml ? { bodyHtml: draft.bodyHtml } : {}),
          ...(draft.oauthAccountId ? { accountId: draft.oauthAccountId } : {}),
          ...(readRcpt ? { requestReadReceipt: true } : {}),
        },
        source: cmd.source,
        actorId: cmd.actorId,
        timestamp: Date.now(),
        sessionId: cmd.sessionId,
      };
      await deps.bus.dispatch(reply, { tenantId: deps.tenantId });
    } else {
      if (draft.toAddr.length === 0) {
        throw new MailaiError("validation_error", "draft has no To recipients");
      }
      const send: Command = {
        type: "mail:send",
        payload: {
          to: draft.toAddr,
          cc: draft.ccAddr,
          bcc: draft.bccAddr,
          subject: draft.subject ?? "",
          body,
          ...(draft.bodyHtml ? { bodyHtml: draft.bodyHtml } : {}),
          ...(draft.oauthAccountId ? { accountId: draft.oauthAccountId } : {}),
          ...(readRcpt ? { requestReadReceipt: true } : {}),
        },
        source: cmd.source,
        actorId: cmd.actorId,
        timestamp: Date.now(),
        sessionId: cmd.sessionId,
      };
      await deps.bus.dispatch(send, { tenantId: deps.tenantId });
    }
    await withTenant(deps.pool, deps.tenantId, (tx) => {
      const repo = new DraftsRepository(tx);
      return repo.delete(deps.tenantId, cmd.actorId, cmd.payload.id);
    });
    return diff(draft, null);
  };
}

function wrap(row: DraftRow, isCreate: boolean): HandlerResult {
  const before: EntitySnapshot = {
    kind: "draft",
    id: row.id,
    version: isCreate ? 0 : 1,
    data: {},
  };
  const after: EntitySnapshot = {
    kind: "draft",
    id: row.id,
    version: 1,
    data: snapshot(row),
  };
  return { before: [before], after: [after], imapSideEffects: [] };
}

function diff(before: DraftRow | null, after: DraftRow | null, fallbackId?: string): HandlerResult {
  const id = after?.id ?? before?.id ?? fallbackId ?? "draft_unknown";
  return {
    before: [
      {
        kind: "draft",
        id,
        version: before ? 1 : 0,
        data: before ? snapshot(before) : {},
      },
    ],
    after: [
      {
        kind: "draft",
        id,
        version: after ? 2 : 0,
        data: after ? snapshot(after) : {},
      },
    ],
    imapSideEffects: [],
  };
}

function snapshot(row: DraftRow): Record<string, unknown> {
  return {
    to: row.toAddr,
    cc: row.ccAddr,
    bcc: row.bccAddr,
    subject: row.subject,
    bodyText: row.bodyText,
    bodyHtml: row.bodyHtml,
    providerThreadId: row.providerThreadId,
    replyToMessageId: row.replyToMessageId,
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
