// CommandBus handler for `mail:send` and `mail:reply`.
//
// Provider routing:
//   - google-mail accounts → Gmail REST users.messages.send
//   - outlook accounts     → Microsoft Graph /me/sendMail
// Both REST endpoints automatically place the message in the user's
// "Sent" folder, which is what the IMAP Coexistence Integrity bar in
// the spec demands.
//
// Account selection rules:
//   1. payload.accountId, if provided
//   2. otherwise the first connected account for this tenant
//      (the dev-stub identity has at most one in practice; multi-
//      account routing is a follow-up once we have inbox→account
//      bindings exposed in the UI)
//
// Threading: for `mail:reply` we look up the source thread via the
// OAuth-message store and:
//   - Gmail: include the providerThreadId so the conversation stays
//     glued in Gmail's UI.
//   - Graph: emit In-Reply-To + References headers via
//     internetMessageHeaders so Outlook threads correctly.

import type {
  CommandHandler,
  EntitySnapshot,
  HandlerContext,
  HandlerResult,
} from "@mailai/core";
import { MailaiError } from "@mailai/core";
import {
  OauthAccountsRepository,
  OauthMessagesRepository,
  withTenant,
  type OauthAccountRow,
  type Pool,
} from "@mailai/overlay-db";
import {
  getValidAccessToken,
  sendGmail,
  sendGraph,
  type ProviderCredentials,
} from "@mailai/oauth-tokens";

export interface MailSendDeps {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly credentials: ProviderCredentials;
}

interface SendPayload {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  accountId?: string;
}

interface ReplyPayload {
  threadId: string;
  body: string;
  accountId?: string;
}

export function buildMailSendHandler(deps: MailSendDeps): CommandHandler<"mail:send", SendPayload> {
  return async (cmd, ctx) => {
    const payload = cmd.payload;
    const account = await pickAccount(deps, payload.accountId);
    return sendAndSnapshot(deps, account, ctx, {
      kind: "send",
      to: payload.to,
      cc: payload.cc,
      bcc: payload.bcc,
      subject: payload.subject,
      body: payload.body,
      ...(payload.inReplyTo ? { inReplyTo: payload.inReplyTo } : {}),
    });
  };
}

export function buildMailReplyHandler(deps: MailSendDeps): CommandHandler<"mail:reply", ReplyPayload> {
  return async (cmd, ctx) => {
    const payload = cmd.payload;

    // Look up the source thread to (a) borrow the From->To address,
    // (b) borrow the subject line (with Re: prefix), and (c) get the
    // provider-side threading hooks.
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
      throw new MailaiError("validation_error", "source message has no from address to reply to");
    }
    const subject = root.subject ? prefixRe(root.subject) : "(no subject)";
    const ref = root.providerMessageId;

    return sendAndSnapshot(deps, account, ctx, {
      kind: "reply",
      to: [replyTo],
      subject,
      body: payload.body,
      providerThreadId: root.providerThreadId,
      inReplyToProviderId: ref,
    });
  };
}

interface SendIntent {
  kind: "send" | "reply";
  to: string[];
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  subject: string;
  body: string;
  inReplyTo?: string | undefined;
  providerThreadId?: string | undefined;
  inReplyToProviderId?: string | undefined;
}

async function sendAndSnapshot(
  deps: MailSendDeps,
  account: OauthAccountRow,
  _ctx: HandlerContext,
  intent: SendIntent,
): Promise<HandlerResult> {
  // Refresh the access token if it's near expiry. getValidAccessToken
  // persists the new token through the repo so subsequent sends pick
  // it up without an extra round-trip.
  const accessToken = await withTenant(deps.pool, deps.tenantId, async (tx) => {
    const repo = new OauthAccountsRepository(tx);
    return getValidAccessToken(account, {
      tenantId: deps.tenantId,
      accounts: repo,
      credentials: deps.credentials,
    });
  });

  const messageId = generateMessageId(account.email);
  const inReplyTo = intent.inReplyTo ?? intent.inReplyToProviderId;

  if (account.provider === "google-mail") {
    const mime = buildMime({
      from: account.email,
      to: intent.to,
      ...(intent.cc ? { cc: intent.cc } : {}),
      ...(intent.bcc ? { bcc: intent.bcc } : {}),
      subject: intent.subject,
      body: intent.body,
      messageId,
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(inReplyTo ? { references: [inReplyTo] } : {}),
    });
    const result = await sendGmail({
      accessToken,
      raw: mime,
      ...(intent.providerThreadId ? { threadId: intent.providerThreadId } : {}),
    });
    return wrapSnapshot(result.id, intent, result.threadId);
  }

  if (account.provider === "outlook") {
    const headers = inReplyTo
      ? [
          { name: "In-Reply-To", value: angle(inReplyTo) },
          { name: "References", value: angle(inReplyTo) },
        ]
      : undefined;
    await sendGraph({
      accessToken,
      subject: intent.subject,
      body: intent.body,
      to: intent.to,
      ...(intent.cc ? { cc: intent.cc } : {}),
      ...(intent.bcc ? { bcc: intent.bcc } : {}),
      ...(headers ? { internetMessageHeaders: headers } : {}),
    });
    // Graph doesn't return the message id from sendMail (only 202).
    return wrapSnapshot(messageId, intent, intent.providerThreadId ?? null);
  }

  throw new MailaiError(
    "validation_error",
    `account ${account.id} has unsupported provider ${account.provider}`,
  );
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
      throw new MailaiError("validation_error", "no connected accounts; connect one in Settings → Accounts");
    }
    return first;
  });
}

function wrapSnapshot(
  messageId: string,
  intent: SendIntent,
  providerThreadId: string | null,
): HandlerResult {
  // Emit a Mutation snapshot so the audit log records what was sent.
  // We do NOT insert into oauth_messages; the next sync pass will pick
  // up the message from the provider's Sent folder (Gmail returns it
  // immediately; Graph the next list call) and persist it through the
  // normal sync path. Doing it twice would create dupes.
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

// Minimal RFC 5322 builder. text/plain, ASCII subject if possible
// (otherwise RFC 2047 encoded-word). Sufficient for the OAuth-only
// MVP; HTML / attachments land in a follow-up that brings in
// nodemailer's MimeNode.
function buildMime(args: {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
}): string {
  const lines: string[] = [];
  lines.push(`From: ${args.from}`);
  lines.push(`To: ${args.to.join(", ")}`);
  if (args.cc && args.cc.length > 0) lines.push(`Cc: ${args.cc.join(", ")}`);
  if (args.bcc && args.bcc.length > 0) lines.push(`Bcc: ${args.bcc.join(", ")}`);
  lines.push(`Subject: ${encodeHeader(args.subject)}`);
  lines.push(`Date: ${new Date().toUTCString()}`);
  lines.push(`Message-ID: ${angle(args.messageId)}`);
  if (args.inReplyTo) lines.push(`In-Reply-To: ${angle(args.inReplyTo)}`);
  if (args.references && args.references.length > 0) {
    lines.push(`References: ${args.references.map(angle).join(" ")}`);
  }
  lines.push(`MIME-Version: 1.0`);
  lines.push(`Content-Type: text/plain; charset="utf-8"`);
  lines.push(`Content-Transfer-Encoding: quoted-printable`);
  lines.push("");
  lines.push(quotedPrintable(args.body));
  return lines.join("\r\n");
}

function encodeHeader(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return `=?utf-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

function angle(id: string): string {
  return id.startsWith("<") ? id : `<${id}>`;
}

function generateMessageId(localDomain: string): string {
  const at = localDomain.includes("@") ? localDomain.split("@")[1] : localDomain;
  return `${Date.now()}.${Math.random().toString(36).slice(2, 10)}@${at}.mail-ai`;
}

function prefixRe(subject: string): string {
  return /^re:\s*/i.test(subject) ? subject : `Re: ${subject}`;
}

// Quoted-printable per RFC 2045 §6.7. Conservative encoder: any
// non-printable, '=', or non-ASCII byte gets =XX-escaped. Lines kept
// under the 76-char soft limit using soft-break "=\r\n".
function quotedPrintable(input: string): string {
  const bytes = Buffer.from(input, "utf8");
  let out = "";
  let lineLen = 0;
  const flush = (chunk: string) => {
    if (lineLen + chunk.length > 75) {
      out += "=\r\n";
      lineLen = 0;
    }
    out += chunk;
    lineLen += chunk.length;
  };
  for (const b of bytes) {
    if (b === 0x0a) {
      out += "\r\n";
      lineLen = 0;
      continue;
    }
    if (b === 0x0d) continue;
    const printable =
      (b >= 0x21 && b <= 0x7e && b !== 0x3d) || b === 0x20 || b === 0x09;
    flush(printable ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, "0")}`);
  }
  return out;
}
