// Raw EML download + "Show original" routes.
//
//   GET /api/messages/:id/raw.eml      → 302 to presigned GET (download)
//   GET /api/messages/:id/headers      → JSON { headers, raw } parsed via @mailai/mime
//
// The EML bytes are cached in S3 at
// `accounts/<account-id>/messages/<provider-id>/raw.eml` so each
// message is fetched at most once over its lifetime (Gmail's `format=raw`
// is ~5x cheaper than `format=full` quota-wise but still costs an API
// call we can avoid).

import type { FastifyInstance } from "fastify";
import {
  OauthAccountsRepository,
  OauthMessagesRepository,
  attachmentKeys,
  withTenant,
  type ObjectStore,
  type Pool,
} from "@mailai/overlay-db";
import {
  getValidAccessToken,
  type ProviderCredentials,
} from "@mailai/oauth-tokens";
import type { MailProviderId, MailProviderRegistry } from "@mailai/providers";
import { parseMessage } from "@mailai/mime";

export interface RawMessageRoutesDeps {
  readonly pool: Pool;
  readonly objectStore: ObjectStore;
  readonly credentials: ProviderCredentials;
  readonly providers: MailProviderRegistry;
  readonly identity: (req: { headers: Record<string, unknown> }) => Promise<{
    userId: string;
    tenantId: string;
  }>;
}

interface RawCtx {
  tenantId: string;
  key: string;
  message: {
    providerMessageId: string;
    subject: string | null;
    oauthAccountId: string;
    provider: MailProviderId;
  };
}

export function registerRawMessageRoutes(
  app: FastifyInstance,
  deps: RawMessageRoutesDeps,
): void {
  app.get("/api/messages/:id/raw.eml", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const { id } = req.params as { id: string };
    const ctx = await loadContext(deps, ident.tenantId, id);
    if (!ctx) {
      return reply.code(404).send({ error: "not_found", message: `message ${id} not found` });
    }
    await ensureRawCached(deps, ctx);
    const filename = sanitizeFilename(ctx.message.subject ?? "message") + ".eml";
    const presigned = await deps.objectStore.presignGet(ctx.key, {
      expiresInSeconds: 600,
      responseContentDisposition: `attachment; filename="${filename}"`,
      responseContentType: "message/rfc822",
    });
    return reply.redirect(presigned.url, 302);
  });

  app.get("/api/messages/:id/headers", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const { id } = req.params as { id: string };
    const ctx = await loadContext(deps, ident.tenantId, id);
    if (!ctx) {
      return reply.code(404).send({ error: "not_found", message: `message ${id} not found` });
    }
    await ensureRawCached(deps, ctx);
    const buf = await deps.objectStore.getBytes(ctx.key);
    const parsed = await parseMessage(buf);
    return {
      headers: parsed.rawHeaders,
      messageId: parsed.messageId,
      subject: parsed.subject,
      from: parsed.from,
      to: parsed.to,
      cc: parsed.cc,
      bcc: parsed.bcc,
      date: parsed.date ? parsed.date.toISOString() : null,
      raw: buf.toString("utf8"),
    };
  });
}

async function loadContext(
  deps: RawMessageRoutesDeps,
  tenantId: string,
  id: string,
): Promise<RawCtx | null> {
  return withTenant(deps.pool, tenantId, async (tx) => {
    const repo = new OauthMessagesRepository(tx);
    const row = await repo.byId(tenantId, id);
    if (!row) return null;
    return {
      tenantId,
      key: attachmentKeys.accountMessageRaw(row.oauthAccountId, row.providerMessageId),
      message: {
        providerMessageId: row.providerMessageId,
        subject: row.subject,
        oauthAccountId: row.oauthAccountId,
        provider: row.provider,
      },
    };
  });
}

async function ensureRawCached(deps: RawMessageRoutesDeps, ctx: RawCtx): Promise<void> {
  if (await deps.objectStore.exists(ctx.key)) return;
  const account = await withTenant(deps.pool, ctx.tenantId, async (tx) => {
    const repo = new OauthAccountsRepository(tx);
    return repo.byId(ctx.tenantId, ctx.message.oauthAccountId);
  });
  if (!account) throw new Error(`account ${ctx.message.oauthAccountId} missing`);
  const accessToken = await withTenant(deps.pool, ctx.tenantId, async (tx) => {
    const repo = new OauthAccountsRepository(tx);
    return getValidAccessToken(account, {
      tenantId: ctx.tenantId,
      accounts: repo,
      credentials: deps.credentials,
    });
  });
  const buf = await deps.providers.for(ctx.message.provider).fetchRawMime({
    accessToken,
    providerMessageId: ctx.message.providerMessageId,
  });
  await deps.objectStore.put(ctx.key, buf, "message/rfc822");
}

function sanitizeFilename(s: string): string {
  return (
    s
      .replace(/[\u0000-\u001f]/g, "")
      .replace(/[\\/:*?"<>|]/g, "_")
      .slice(0, 120)
      .trim() || "message"
  );
}
