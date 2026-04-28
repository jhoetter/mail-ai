// Attachment download endpoints.
//
//   GET /api/attachments/:id           → JSON { url, expiresAt } presigned GET
//   GET /api/attachments/:id/bytes      → raw object bytes (same auth). Used by
//                                        hof-os `SisterAppAttachmentLightbox`,
//                                        which must `fetch().arrayBuffer()` on a
//                                        same-origin URL — the JSON presign
//                                        envelope is not a spreadsheet/PDF.
//   GET /api/attachments/:id/inline    → 302 to presigned GET; used as a
//                                        stable URL we can rewrite cid:
//                                        links to without re-presigning
//                                        on every render.
//
// Lazy-fetch policy: if the byte stream isn't already in S3, we refresh
// the access token, pull the bytes from the provider, PutObject, then
// presign. Subsequent calls hit S3 directly (cachedAt is bumped so we
// can prune unused rows later).

import type { FastifyInstance } from "fastify";
import {
  OauthAccountsRepository,
  OauthAttachmentsRepository,
  withTenant,
  type ObjectStore,
  type OauthAttachmentRow,
  type Pool,
} from "@mailai/overlay-db";
import { getValidAccessToken, type ProviderCredentials } from "@mailai/oauth-tokens";
import type { MailProviderRegistry } from "@mailai/providers";

export interface AttachmentRoutesDeps {
  readonly pool: Pool;
  readonly objectStore: ObjectStore;
  readonly credentials: ProviderCredentials;
  readonly providers: MailProviderRegistry;
  readonly identity: (req: { headers: Record<string, unknown> }) => Promise<{
    userId: string;
    tenantId: string;
  }>;
}

export function registerAttachmentRoutes(app: FastifyInstance, deps: AttachmentRoutesDeps): void {
  app.get("/api/attachments/:id/bytes", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const { id } = req.params as { id: string };
    const row = await loadAttachment(deps, ident.tenantId, id);
    if (!row) {
      return reply.code(404).send({ error: "not_found", message: `attachment ${id} not found` });
    }
    await ensureCached(deps, ident.tenantId, row);
    const filename = row.filename ?? "attachment.bin";
    const buf = await deps.objectStore.getBytes(row.objectKey);
    return reply
      .header("cache-control", "private, max-age=300")
      .header("content-type", row.mime || "application/octet-stream")
      .header(
        "content-disposition",
        `attachment; filename="${escapeFilename(filename)}"`,
      )
      .send(buf);
  });

  app.get("/api/attachments/:id", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const { id } = req.params as { id: string };
    const row = await loadAttachment(deps, ident.tenantId, id);
    if (!row) {
      return reply.code(404).send({ error: "not_found", message: `attachment ${id} not found` });
    }
    await ensureCached(deps, ident.tenantId, row);
    const filename = row.filename ?? "attachment.bin";
    const presigned = await deps.objectStore.presignGet(row.objectKey, {
      expiresInSeconds: 600,
      responseContentDisposition: `attachment; filename="${escapeFilename(filename)}"`,
      responseContentType: row.mime,
    });
    return { url: presigned.url, expiresAt: presigned.expiresAt };
  });

  app.get("/api/attachments/:id/inline", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const { id } = req.params as { id: string };
    const row = await loadAttachment(deps, ident.tenantId, id);
    if (!row) {
      return reply.code(404).send({ error: "not_found", message: `attachment ${id} not found` });
    }
    await ensureCached(deps, ident.tenantId, row);
    const filename = row.filename ?? "inline.bin";
    const presigned = await deps.objectStore.presignGet(row.objectKey, {
      expiresInSeconds: 600,
      responseContentDisposition: `inline; filename="${escapeFilename(filename)}"`,
      responseContentType: row.mime,
    });
    return reply.header("cache-control", "private, max-age=600").redirect(presigned.url, 302);
  });
}

async function loadAttachment(
  deps: AttachmentRoutesDeps,
  tenantId: string,
  id: string,
): Promise<OauthAttachmentRow | null> {
  return withTenant(deps.pool, tenantId, async (tx) => {
    const repo = new OauthAttachmentsRepository(tx);
    return repo.byId(tenantId, id);
  });
}

async function ensureCached(
  deps: AttachmentRoutesDeps,
  tenantId: string,
  row: OauthAttachmentRow,
): Promise<void> {
  if (await deps.objectStore.exists(row.objectKey)) return;
  // Need to fetch from the provider. Look up the account so we know
  // which API to talk to and to refresh the access token.
  await withTenant(deps.pool, tenantId, async (tx) => {
    const accounts = new OauthAccountsRepository(tx);
    const attRepo = new OauthAttachmentsRepository(tx);
    const account = await accounts.byId(tenantId, row.oauthAccountId);
    if (!account) throw new Error(`account ${row.oauthAccountId} missing for attachment ${row.id}`);
    const accessToken = await getValidAccessToken(account, {
      tenantId,
      accounts,
      credentials: deps.credentials,
    });
    if (!row.providerAttachmentId) {
      throw new Error(`attachment ${row.id} has no providerAttachmentId`);
    }
    const bytes = await deps.providers.for(account.provider).fetchAttachmentBytes({
      accessToken,
      providerMessageId: row.providerMessageId,
      attachment: {
        providerAttachmentId: row.providerAttachmentId,
        filename: row.filename ?? "attachment",
        mime: row.mime,
        sizeBytes: row.sizeBytes,
        contentId: row.contentId ?? null,
        isInline: row.isInline,
      },
    });
    await deps.objectStore.put(row.objectKey, bytes, row.mime);
    await attRepo.markCached(tenantId, row.id);
  });
}

function escapeFilename(name: string): string {
  return name.replace(/"/g, "'");
}
