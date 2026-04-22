// CommandBus handlers for outbound mail + read/star toggles.
//
// Outbound provider routing:
//   - google-mail accounts → Gmail REST users.messages.send (raw MIME)
//   - outlook accounts     → Microsoft Graph /me/sendMail (raw MIME via
//                            text/plain content-type, base64 body)
// Both REST endpoints automatically place the message in the user's
// "Sent" folder, which is what the IMAP Coexistence Integrity bar in
// the spec demands.
//
// MIME composition lives in @mailai/mime/composeMessage(); this file
// only orchestrates: pick account → refresh token → fetch attachment
// bytes from S3 → compose → send → mirror metadata.
//
// Read/star/forward are colocated here because they share the
// account-pick + token-refresh setup with send.

import type {
  CommandHandler,
  EntitySnapshot,
  HandlerContext,
  HandlerResult,
} from "@mailai/core";
import { MailaiError, randomId } from "@mailai/core";
import {
  DraftAttachmentsRepository,
  OauthAccountsRepository,
  OauthAttachmentsRepository,
  OauthMessagesRepository,
  attachmentKeys,
  withTenant,
  type DraftAttachmentRow,
  type ObjectStore,
  type OauthAccountRow,
  type Pool,
} from "@mailai/overlay-db";
import {
  fetchGmailRawMessage,
  fetchGraphRawMessage,
  getValidAccessToken,
  modifyGmailMessageLabels,
  patchGraphMessage,
  sendGmail,
  sendGraphRawMime,
  type ProviderCredentials,
} from "@mailai/oauth-tokens";
import { composeMessage, type AttachmentSpec } from "@mailai/mime";

export interface MailSendDeps {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly credentials: ProviderCredentials;
  readonly objectStore: ObjectStore;
}

interface AttachmentRef {
  fileId: string;
}

interface SendPayload {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  bodyHtml?: string;
  inReplyTo?: string;
  accountId?: string;
  attachments?: AttachmentRef[];
  draftId?: string;
}

interface ReplyPayload {
  threadId: string;
  body: string;
  bodyHtml?: string;
  accountId?: string;
  attachments?: AttachmentRef[];
}

interface ForwardPayload {
  providerMessageId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body: string;
  bodyHtml?: string;
  attachments?: AttachmentRef[];
  includeOriginalAsEml?: boolean;
  accountId?: string;
}

interface MarkReadPayload {
  providerThreadId: string;
  accountId?: string;
}

interface StarPayload {
  providerMessageId: string;
  starred: boolean;
  accountId?: string;
}

export function buildMailSendHandler(
  deps: MailSendDeps,
): CommandHandler<"mail:send", SendPayload> {
  return async (cmd, ctx) => {
    const payload = cmd.payload;
    const account = await pickAccount(deps, payload.accountId);
    return sendAndSnapshot(deps, account, ctx, {
      kind: "send",
      to: payload.to,
      ...(payload.cc ? { cc: payload.cc } : {}),
      ...(payload.bcc ? { bcc: payload.bcc } : {}),
      subject: payload.subject,
      body: payload.body,
      ...(payload.bodyHtml ? { bodyHtml: payload.bodyHtml } : {}),
      ...(payload.inReplyTo ? { inReplyTo: payload.inReplyTo } : {}),
      ...(payload.attachments ? { attachmentRefs: payload.attachments } : {}),
      ...(payload.draftId ? { draftId: payload.draftId } : {}),
    });
  };
}

export function buildMailReplyHandler(
  deps: MailSendDeps,
): CommandHandler<"mail:reply", ReplyPayload> {
  return async (cmd, ctx) => {
    const payload = cmd.payload;

    const root = await withTenant(deps.pool, deps.tenantId, (tx) => {
      const repo = new OauthMessagesRepository(tx);
      return repo.byId(deps.tenantId, payload.threadId);
    });
    if (!root) {
      throw new MailaiError("not_found", `thread ${payload.threadId} not found`);
    }
    const account = await pickAccount(deps, payload.accountId ?? root.oauthAccountId);
    const replyTo = root.fromEmail;
    if (!replyTo) {
      throw new MailaiError(
        "validation_error",
        "source message has no from address to reply to",
      );
    }
    const subject = root.subject ? prefixRe(root.subject) : "(no subject)";
    const ref = root.providerMessageId;

    return sendAndSnapshot(deps, account, ctx, {
      kind: "reply",
      to: [replyTo],
      subject,
      body: payload.body,
      ...(payload.bodyHtml ? { bodyHtml: payload.bodyHtml } : {}),
      providerThreadId: root.providerThreadId,
      inReplyToProviderId: ref,
      ...(payload.attachments ? { attachmentRefs: payload.attachments } : {}),
    });
  };
}

export function buildMailForwardHandler(
  deps: MailSendDeps,
): CommandHandler<"mail:forward", ForwardPayload> {
  return async (cmd, ctx) => {
    const payload = cmd.payload;
    // Source must exist locally so we can borrow subject / threading
    // hooks, and so the includeOriginalAsEml path can fetch raw bytes
    // from the same account.
    const source = await withTenant(deps.pool, deps.tenantId, async (tx) => {
      const messages = new OauthMessagesRepository(tx);
      const all = await messages.listByTenant(deps.tenantId, { limit: 500 });
      return all.find((m) => m.providerMessageId === payload.providerMessageId) ?? null;
    });
    if (!source) {
      throw new MailaiError(
        "not_found",
        `source message ${payload.providerMessageId} not found locally`,
      );
    }
    const account = await pickAccount(deps, payload.accountId ?? source.oauthAccountId);
    const subject = payload.subject ?? prefixFwd(source.subject ?? "(no subject)");
    let forwardedRaw: Buffer | null = null;
    if (payload.includeOriginalAsEml !== false) {
      forwardedRaw = await loadRawForMessage(deps, account, source.providerMessageId);
    }
    return sendAndSnapshot(deps, account, ctx, {
      kind: "forward",
      to: payload.to,
      ...(payload.cc ? { cc: payload.cc } : {}),
      ...(payload.bcc ? { bcc: payload.bcc } : {}),
      subject,
      body: payload.body,
      ...(payload.bodyHtml ? { bodyHtml: payload.bodyHtml } : {}),
      ...(payload.attachments ? { attachmentRefs: payload.attachments } : {}),
      ...(forwardedRaw ? { forwardedRaw } : {}),
    });
  };
}

export function buildMailMarkReadHandler(
  deps: MailSendDeps,
): CommandHandler<"mail:mark-read", MarkReadPayload> {
  return buildMarkReadOrUnread(deps, false);
}

export function buildMailMarkUnreadHandler(
  deps: MailSendDeps,
): CommandHandler<"mail:mark-unread", MarkReadPayload> {
  return buildMarkReadOrUnread(deps, true);
}

function buildMarkReadOrUnread<T extends "mail:mark-read" | "mail:mark-unread">(
  deps: MailSendDeps,
  unread: boolean,
): CommandHandler<T, MarkReadPayload> {
  return (async (cmd) => {
    const payload = cmd.payload;
    const rows = await withTenant(deps.pool, deps.tenantId, async (tx) => {
      const repo = new OauthMessagesRepository(tx);
      return (
        await repo.listByTenant(deps.tenantId, { limit: 500 })
      ).filter((m) => m.providerThreadId === payload.providerThreadId);
    });
    if (rows.length === 0) {
      // Nothing to do — return an empty snapshot rather than failing,
      // so the optimistic UI doesn't trip on an out-of-window thread.
      return { before: [], after: [], imapSideEffects: [] };
    }
    const accountId = payload.accountId ?? rows[0]!.oauthAccountId;
    const account = await pickAccount(deps, accountId);
    const accessToken = await refreshToken(deps, account);
    for (const m of rows) {
      try {
        if (account.provider === "google-mail") {
          await modifyGmailMessageLabels({
            accessToken,
            messageId: m.providerMessageId,
            ...(unread
              ? { addLabelIds: ["UNREAD"] }
              : { removeLabelIds: ["UNREAD"] }),
          });
        } else if (account.provider === "outlook") {
          await patchGraphMessage({
            accessToken,
            messageId: m.providerMessageId,
            patch: { isRead: !unread },
          });
        }
      } catch (err) {
        console.warn("[mail:mark-read] provider call failed", {
          messageId: m.providerMessageId,
          err: String(err),
        });
      }
    }
    await withTenant(deps.pool, deps.tenantId, async (tx) => {
      const repo = new OauthMessagesRepository(tx);
      await repo.setUnreadByThread(deps.tenantId, payload.providerThreadId, unread);
    });
    const snapshot: EntitySnapshot = {
      kind: "thread",
      id: payload.providerThreadId,
      version: 1,
      data: { unread },
    };
    return {
      before: [{ kind: "thread", id: payload.providerThreadId, version: 0, data: {} }],
      after: [snapshot],
      imapSideEffects: [],
    };
  }) as CommandHandler<T, MarkReadPayload>;
}

export function buildMailStarHandler(
  deps: MailSendDeps,
): CommandHandler<"mail:star", StarPayload> {
  return async (cmd) => {
    const payload = cmd.payload;
    const message = await withTenant(deps.pool, deps.tenantId, async (tx) => {
      const repo = new OauthMessagesRepository(tx);
      const all = await repo.listByTenant(deps.tenantId, { limit: 500 });
      return all.find((m) => m.providerMessageId === payload.providerMessageId) ?? null;
    });
    if (!message) {
      throw new MailaiError(
        "not_found",
        `message ${payload.providerMessageId} not found locally`,
      );
    }
    const account = await pickAccount(deps, payload.accountId ?? message.oauthAccountId);
    const accessToken = await refreshToken(deps, account);
    if (account.provider === "google-mail") {
      await modifyGmailMessageLabels({
        accessToken,
        messageId: payload.providerMessageId,
        ...(payload.starred
          ? { addLabelIds: ["STARRED"] }
          : { removeLabelIds: ["STARRED"] }),
      });
    } else if (account.provider === "outlook") {
      await patchGraphMessage({
        accessToken,
        messageId: payload.providerMessageId,
        patch: {
          flag: { flagStatus: payload.starred ? "flagged" : "notFlagged" },
        },
      });
    }
    await withTenant(deps.pool, deps.tenantId, async (tx) => {
      const repo = new OauthMessagesRepository(tx);
      await repo.setStarred(
        deps.tenantId,
        message.oauthAccountId,
        payload.providerMessageId,
        payload.starred,
      );
    });
    const snapshot: EntitySnapshot = {
      kind: "message",
      id: payload.providerMessageId,
      version: 1,
      data: { starred: payload.starred },
    };
    return {
      before: [
        { kind: "message", id: payload.providerMessageId, version: 0, data: {} },
      ],
      after: [snapshot],
      imapSideEffects: [],
    };
  };
}

interface SendIntent {
  kind: "send" | "reply" | "forward";
  to: string[];
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  subject: string;
  body: string;
  bodyHtml?: string | undefined;
  inReplyTo?: string | undefined;
  providerThreadId?: string | undefined;
  inReplyToProviderId?: string | undefined;
  attachmentRefs?: AttachmentRef[] | undefined;
  draftId?: string | undefined;
  forwardedRaw?: Buffer | undefined;
}

async function sendAndSnapshot(
  deps: MailSendDeps,
  account: OauthAccountRow,
  _ctx: HandlerContext,
  intent: SendIntent,
): Promise<HandlerResult> {
  const accessToken = await refreshToken(deps, account);
  const inReplyTo = intent.inReplyTo ?? intent.inReplyToProviderId;

  // Resolve attachment metadata + bytes once per send.
  const attachments = await loadAttachmentBytes(deps, intent.attachmentRefs ?? []);

  // Apply the per-account signature when the caller supplied one of
  // the body shapes. The composer prepends the signature wrapped in a
  // sentinel div so future automation can strip it cleanly.
  const bodyText = applySignature("text", intent.body, account.signatureText);
  const bodyHtml = intent.bodyHtml
    ? applySignature("html", intent.bodyHtml, account.signatureHtml)
    : undefined;

  const composed = composeMessage({
    from: account.email,
    to: intent.to,
    ...(intent.cc ? { cc: intent.cc } : {}),
    ...(intent.bcc ? { bcc: intent.bcc } : {}),
    subject: intent.subject,
    textBody: bodyText,
    ...(bodyHtml ? { htmlBody: bodyHtml } : {}),
    ...(inReplyTo ? { inReplyTo: angle(inReplyTo) } : {}),
    ...(inReplyTo ? { references: [angle(inReplyTo)] } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(intent.forwardedRaw
      ? { forwarded: { raw: intent.forwardedRaw, filename: "forwarded.eml" } }
      : {}),
  });
  const messageId = composed.messageId.replace(/^<|>$/g, "");

  let providerMessageId = messageId;
  let providerThreadId: string | null = intent.providerThreadId ?? null;

  if (account.provider === "google-mail") {
    const result = await sendGmail({
      accessToken,
      raw: composed.raw,
      ...(intent.providerThreadId ? { threadId: intent.providerThreadId } : {}),
    });
    providerMessageId = result.id;
    providerThreadId = result.threadId;
  } else if (account.provider === "outlook") {
    await sendGraphRawMime({ accessToken, raw: composed.raw });
    // Graph's raw send returns 202 with no id; subsequent sync will
    // pick it up from Sent and we'll dedupe via the local Message-ID.
  } else {
    throw new MailaiError(
      "validation_error",
      `account ${account.id} has unsupported provider ${account.provider}`,
    );
  }

  // Mirror draft-staged attachment metadata into oauth_attachments
  // so the freshly-sent message renders with its tray on the next
  // sync, even if the provider hasn't returned the message yet.
  if (attachments.length > 0) {
    await mirrorAttachmentsToMessage(
      deps,
      account,
      providerMessageId,
      intent.attachmentRefs ?? [],
    );
  }

  // Discard the draft staging tree so the AttachmentTray clears for
  // the next composer open.
  if (intent.draftId) {
    await withTenant(deps.pool, deps.tenantId, async (tx) => {
      const repo = new DraftAttachmentsRepository(tx);
      await repo.deleteForDraft(deps.tenantId, intent.draftId!);
    });
  }

  return wrapSnapshot(providerMessageId, intent, providerThreadId);
}

async function refreshToken(deps: MailSendDeps, account: OauthAccountRow): Promise<string> {
  return withTenant(deps.pool, deps.tenantId, async (tx) => {
    const repo = new OauthAccountsRepository(tx);
    return getValidAccessToken(account, {
      tenantId: deps.tenantId,
      accounts: repo,
      credentials: deps.credentials,
    });
  });
}

async function loadAttachmentBytes(
  deps: MailSendDeps,
  refs: readonly AttachmentRef[],
): Promise<AttachmentSpec[]> {
  if (refs.length === 0) return [];
  const out: AttachmentSpec[] = [];
  const rows: DraftAttachmentRow[] = [];
  await withTenant(deps.pool, deps.tenantId, async (tx) => {
    const repo = new DraftAttachmentsRepository(tx);
    for (const r of refs) {
      const row = await repo.byId(deps.tenantId, r.fileId);
      if (!row) {
        throw new MailaiError("not_found", `attachment ${r.fileId} not found`);
      }
      rows.push(row);
    }
  });
  for (const row of rows) {
    const buf = await deps.objectStore.getBytes(row.objectKey);
    out.push({
      filename: row.filename,
      contentType: row.mime,
      content: buf,
    });
  }
  return out;
}

async function mirrorAttachmentsToMessage(
  deps: MailSendDeps,
  account: OauthAccountRow,
  providerMessageId: string,
  refs: readonly AttachmentRef[],
): Promise<void> {
  await withTenant(deps.pool, deps.tenantId, async (tx) => {
    const drafts = new DraftAttachmentsRepository(tx);
    const realm = new OauthAttachmentsRepository(tx);
    for (const r of refs) {
      const row = await drafts.byId(deps.tenantId, r.fileId);
      if (!row) continue;
      const id = `att_${randomId()}`;
      const newKey = attachmentKeys.accountMessageAtt(
        account.id,
        providerMessageId,
        id,
      );
      // Best-effort copy from drafts/* to accounts/*. We don't fail
      // the send if the copy errors — the draft key is still readable
      // until the janitor sweeps; the next thread render will fall
      // back to the provider attachment fetch.
      try {
        const buf = await deps.objectStore.getBytes(row.objectKey);
        await deps.objectStore.put(newKey, buf, row.mime);
        await realm.upsertForMessage({
          id,
          tenantId: deps.tenantId,
          oauthAccountId: account.id,
          providerMessageId,
          providerAttachmentId: null,
          objectKey: newKey,
          filename: row.filename,
          mime: row.mime,
          sizeBytes: row.sizeBytes,
          contentId: null,
          isInline: false,
        });
      } catch (err) {
        console.warn("[mail:send] failed to mirror draft attachment", {
          fileId: r.fileId,
          err: String(err),
        });
      }
    }
  });
}

async function loadRawForMessage(
  deps: MailSendDeps,
  account: OauthAccountRow,
  providerMessageId: string,
): Promise<Buffer> {
  // Cache the raw bytes in S3 under accounts/.../raw.eml so subsequent
  // forward / Show Original / .eml downloads are a single GET.
  const key = attachmentKeys.accountMessageRaw(account.id, providerMessageId);
  if (await deps.objectStore.exists(key)) {
    return deps.objectStore.getBytes(key);
  }
  const accessToken = await refreshToken(deps, account);
  const buf =
    account.provider === "google-mail"
      ? await fetchGmailRawMessage({ accessToken, messageId: providerMessageId })
      : await fetchGraphRawMessage({ accessToken, messageId: providerMessageId });
  await deps.objectStore.put(key, buf, "message/rfc822");
  return buf;
}

async function pickAccount(
  deps: MailSendDeps,
  requestedId?: string,
): Promise<OauthAccountRow> {
  return withTenant(deps.pool, deps.tenantId, async (tx) => {
    const repo = new OauthAccountsRepository(tx);
    if (requestedId) {
      const row = await repo.byId(deps.tenantId, requestedId);
      if (!row) {
        throw new MailaiError("not_found", `account ${requestedId} not found`);
      }
      return row;
    }
    const all = await repo.listByTenant(deps.tenantId);
    const first = all[0];
    if (!first) {
      throw new MailaiError(
        "validation_error",
        "no connected accounts; connect one in Settings → Accounts",
      );
    }
    return first;
  });
}

function wrapSnapshot(
  messageId: string,
  intent: SendIntent,
  providerThreadId: string | null,
): HandlerResult {
  const snapshot: EntitySnapshot = {
    kind: "message",
    id: messageId,
    version: 1,
    data: {
      to: intent.to,
      cc: intent.cc ?? [],
      bcc: intent.bcc ?? [],
      subject: intent.subject,
      bodyPreview: intent.body.slice(0, 280),
      providerThreadId,
      kind: intent.kind,
    },
  };
  return {
    before: [{ kind: "message", id: messageId, version: 0, data: {} }],
    after: [snapshot],
    imapSideEffects: [],
  };
}

function angle(id: string): string {
  return id.startsWith("<") ? id : `<${id}>`;
}

function prefixRe(subject: string): string {
  return /^re:\s*/i.test(subject) ? subject : `Re: ${subject}`;
}

function prefixFwd(subject: string): string {
  return /^fwd?:\s*/i.test(subject) ? subject : `Fwd: ${subject}`;
}

function applySignature(
  kind: "text" | "html",
  body: string,
  signature: string | null,
): string {
  if (!signature || signature.trim().length === 0) return body;
  if (kind === "text") {
    if (body.includes(signature.slice(0, 60))) return body;
    return `${body}\r\n\r\n-- \r\n${signature}`;
  }
  if (body.includes("data-mailai-signature")) return body;
  return `${body}<div class="mailai-signature" data-mailai-signature>${signature}</div>`;
}
