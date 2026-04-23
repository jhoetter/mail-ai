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

import type { CommandHandler, EntitySnapshot, HandlerContext, HandlerResult } from "@mailai/core";
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
import { getValidAccessToken, type ProviderCredentials } from "@mailai/oauth-tokens";
import type { MailProviderId, MailProviderRegistry } from "@mailai/providers";
import { composeMessage, type AttachmentSpec } from "@mailai/mime";

export interface MailSendDeps {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly credentials: ProviderCredentials;
  readonly objectStore: ObjectStore;
  readonly providers: MailProviderRegistry;
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
  // Optional caller-supplied recipient overrides. Vanilla "Reply"
  // omits these and the handler derives To from the source's From
  // header. The web client supplies them when the user has edited
  // the recipient row, picked "Reply all", or added Cc/Bcc.
  to?: string[];
  cc?: string[];
  bcc?: string[];
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

export function buildMailSendHandler(deps: MailSendDeps): CommandHandler<"mail:send", SendPayload> {
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

    // Recipient resolution. Caller-supplied lists take precedence — the
    // user might have removed the original sender, added a CC, etc. We
    // fall back to "reply to From" only when the caller supplied
    // nothing, preserving the original simple-reply contract used by
    // CLI / agent callers.
    const to =
      payload.to && payload.to.length > 0 ? payload.to : root.fromEmail ? [root.fromEmail] : [];
    if (to.length === 0) {
      throw new MailaiError("validation_error", "source message has no from address to reply to");
    }

    const subject = root.subject ? prefixRe(root.subject) : "(no subject)";
    const ref = root.providerMessageId;

    return sendAndSnapshot(deps, account, ctx, {
      kind: "reply",
      to,
      ...(payload.cc && payload.cc.length > 0 ? { cc: payload.cc } : {}),
      ...(payload.bcc && payload.bcc.length > 0 ? { bcc: payload.bcc } : {}),
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
      return (await repo.listByTenant(deps.tenantId, { limit: 500 })).filter(
        (m) => m.providerThreadId === payload.providerThreadId,
      );
    });
    if (rows.length === 0) {
      // Nothing to do — return an empty snapshot rather than failing,
      // so the optimistic UI doesn't trip on an out-of-window thread.
      return { before: [], after: [], imapSideEffects: [] };
    }
    const accountId = payload.accountId ?? rows[0]!.oauthAccountId;
    const account = await pickAccount(deps, accountId);
    const accessToken = await refreshToken(deps, account);
    const adapter = deps.providers.for(account.provider);
    for (const m of rows) {
      try {
        await adapter.setRead({
          accessToken,
          providerMessageId: m.providerMessageId,
          read: !unread,
        });
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

export function buildMailStarHandler(deps: MailSendDeps): CommandHandler<"mail:star", StarPayload> {
  return async (cmd) => {
    const payload = cmd.payload;
    const message = await withTenant(deps.pool, deps.tenantId, async (tx) => {
      const repo = new OauthMessagesRepository(tx);
      const all = await repo.listByTenant(deps.tenantId, { limit: 500 });
      return all.find((m) => m.providerMessageId === payload.providerMessageId) ?? null;
    });
    if (!message) {
      throw new MailaiError("not_found", `message ${payload.providerMessageId} not found locally`);
    }
    const account = await pickAccount(deps, payload.accountId ?? message.oauthAccountId);
    const accessToken = await refreshToken(deps, account);
    await deps.providers.for(account.provider).setStarred({
      accessToken,
      providerMessageId: payload.providerMessageId,
      starred: payload.starred,
    });
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
      before: [{ kind: "message", id: payload.providerMessageId, version: 0, data: {} }],
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

  // Route through the provider registry so this file stays free of
  // gmail/outlook branches. Each adapter advertises whether its send
  // call returns a synchronous id (Gmail does; Graph 202s with an
  // empty body) — we just trust whatever providerMessageId comes
  // back: Gmail returns the real id, Outlook returns the
  // locally-composed Message-ID and the next sync reconciles via
  // the RFC822 Message-ID header.
  const sendResult = await deps.providers.for(account.provider).send({
    accessToken,
    message: {
      raw: composed.raw,
      rfc822MessageId: messageId,
      ...(intent.providerThreadId ? { providerThreadId: intent.providerThreadId } : {}),
    },
  });
  const providerMessageId = sendResult.providerMessageId;
  const providerThreadId: string | null =
    sendResult.providerThreadId ?? intent.providerThreadId ?? null;

  // Mirror the just-sent message into oauth_messages with
  // wellKnownFolder='sent' so the Sent view shows it instantly,
  // before any provider-side sync.
  await mirrorSentMessage(deps, account, {
    providerMessageId,
    providerThreadId: providerThreadId ?? providerMessageId,
    intent,
    snippet: intent.body.slice(0, 280),
  });

  // Mirror draft-staged attachment metadata into oauth_attachments
  // so the freshly-sent message renders with its tray on the next
  // sync, even if the provider hasn't returned the message yet.
  if (attachments.length > 0) {
    await mirrorAttachmentsToMessage(deps, account, providerMessageId, intent.attachmentRefs ?? []);
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

// Insert (or update) the local oauth_messages row representing the
// just-sent message. Without this the user sends a message and then
// stares at an empty Sent folder until the next provider sync (which
// for Outlook can be many minutes). Idempotency is provided by the
// repo's ON CONFLICT (oauth_account_id, provider_message_id) so when
// the real provider sync later returns this same id, we don't get
// duplicates — we just overwrite our local guesses with the
// authoritative server-side values (subject, snippet, etc. unchanged
// in practice; labelsJson rewrites are fine because the next sync
// will re-establish them).
async function mirrorSentMessage(
  deps: MailSendDeps,
  account: OauthAccountRow,
  args: {
    providerMessageId: string;
    providerThreadId: string;
    intent: SendIntent;
    snippet: string;
  },
): Promise<void> {
  const row = buildSentMirrorRow({
    tenantId: deps.tenantId,
    accountId: account.id,
    accountEmail: account.email,
    accountProvider: account.provider,
    providerMessageId: args.providerMessageId,
    providerThreadId: args.providerThreadId,
    subject: args.intent.subject,
    to: args.intent.to,
    ...(args.intent.cc ? { cc: args.intent.cc } : {}),
    ...(args.intent.bcc ? { bcc: args.intent.bcc } : {}),
    snippet: args.snippet,
    sentAt: new Date(),
  });
  await withTenant(deps.pool, deps.tenantId, async (tx) => {
    const repo = new OauthMessagesRepository(tx);
    await repo.upsertMany([row]);
  });
}

export interface SentMirrorInput {
  readonly tenantId: string;
  readonly accountId: string;
  readonly accountEmail: string;
  readonly accountProvider: MailProviderId;
  readonly providerMessageId: string;
  readonly providerThreadId: string;
  readonly subject: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly snippet: string;
  readonly sentAt: Date;
}

// Pure factory exported for unit tests. Keeps the SQL-backed mirror
// path one indirection away from a value-only assertion that the
// row we hand to upsertMany has the shape the Sent view expects
// (wellKnownFolder='sent', unread=false, fromEmail set to the
// account, etc). Labels are intentionally empty: the Sent bucket is
// folder identity, not a label.
export function buildSentMirrorRow(input: SentMirrorInput) {
  return {
    id: `om_${randomId()}`,
    tenantId: input.tenantId,
    oauthAccountId: input.accountId,
    provider: input.accountProvider,
    providerMessageId: input.providerMessageId,
    providerThreadId: input.providerThreadId,
    subject: input.subject,
    fromName: null as string | null,
    fromEmail: input.accountEmail,
    toAddr: input.to.join(", "),
    ccAddr: input.cc && input.cc.length > 0 ? input.cc.join(", ") : null,
    bccAddr: input.bcc && input.bcc.length > 0 ? input.bcc.join(", ") : null,
    snippet: input.snippet,
    internalDate: input.sentAt,
    labelsJson: [] as string[],
    unread: false,
    wellKnownFolder: "sent" as const,
  };
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
      const newKey = attachmentKeys.accountMessageAtt(account.id, providerMessageId, id);
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
  const buf = await deps.providers
    .for(account.provider)
    .fetchRawMime({ accessToken, providerMessageId });
  await deps.objectStore.put(key, buf, "message/rfc822");
  return buf;
}

async function pickAccount(deps: MailSendDeps, requestedId?: string): Promise<OauthAccountRow> {
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

function applySignature(kind: "text" | "html", body: string, signature: string | null): string {
  if (!signature || signature.trim().length === 0) return body;
  if (kind === "text") {
    if (body.includes(signature.slice(0, 60))) return body;
    return `${body}\r\n\r\n-- \r\n${signature}`;
  }
  if (body.includes("data-mailai-signature")) return body;
  return `${body}<div class="mailai-signature" data-mailai-signature>${signature}</div>`;
}
