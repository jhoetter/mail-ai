// Attachment download endpoints.
//
//   GET /api/attachments/:id           → JSON { url, expiresAt } presigned GET
//   GET /api/attachments/:id/bytes      → raw object bytes (same auth). Used by
//                                        hof-os `SisterAppAttachmentLightbox`,
//                                        which must `fetch().arrayBuffer()` on a
//                                        same-origin URL — the JSON presign
//                                        envelope is not a spreadsheet/PDF.
//   GET /api/attachments/:id/office-url → JSON { url } after ensuring the
//                                        object is cached; the browser then
//                                        navigates to hofOS `/edit-asset`.
//   GET /api/attachments/:id/inline    → 302 to presigned GET; used as a
//                                        stable URL we can rewrite cid:
//                                        links to without re-presigning
//                                        on every render.
//
// Lazy-fetch policy: if the byte stream isn't already in S3, we refresh
// the access token, pull the bytes from the provider, PutObject, then
// presign. Subsequent calls hit S3 directly (cachedAt is bumped so we
// can prune unused rows later).

import type { FastifyInstance, FastifyReply } from "fastify";
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

const OBJECT_STORE_UNREACHABLE_BODY = {
  error: "object_store_unreachable",
  message:
    "S3-compatible object storage is not reachable at S3_ENDPOINT. From the mail-ai repo run `make stack-up` or `make stack-up-minio` (MinIO maps host :9200). With hof-os native dev (`HOFOS_SUBAPP_NATIVE=1`), `make dev` now runs stack-up-minio automatically; otherwise start MinIO once manually.",
} as const;

/** True when AWS S3 SDK failed to TCP-connect (MinIO stopped, wrong port, …). */
function isObjectStoreConnectivityError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const maybe = err as { code?: string; cause?: unknown; errors?: unknown[]; aggregateErrors?: unknown[] };
  const code = typeof maybe.code === "string" ? maybe.code : "";
  if (
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "ECONNRESET"
  )
    return true;
  const fromAggregate = [...(maybe.errors ?? []), ...(maybe.aggregateErrors ?? [])];
  for (const e of fromAggregate) {
    if (isObjectStoreConnectivityError(e)) return true;
  }
  return maybe.cause !== undefined ? isObjectStoreConnectivityError(maybe.cause) : false;
}

function replyObjectStoreUnreachable(reply: FastifyReply) {
  return reply.code(503).send(OBJECT_STORE_UNREACHABLE_BODY);
}

export function registerAttachmentRoutes(app: FastifyInstance, deps: AttachmentRoutesDeps): void {
  app.get("/api/attachments/:id/bytes", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const { id } = req.params as { id: string };
    const row = await loadAttachment(deps, ident.tenantId, id);
    if (!row) {
      return reply.code(404).send({ error: "not_found", message: `attachment ${id} not found` });
    }
    try {
      await ensureCached(deps, ident.tenantId, row);
      const filename = row.filename ?? "attachment.bin";
      const buf = await deps.objectStore.getBytes(row.objectKey);
      return reply
        .header("cache-control", "private, max-age=300")
        .header("content-type", row.mime || "application/octet-stream")
        .header("content-disposition", `attachment; filename="${escapeFilename(filename)}"`)
        .send(buf);
    } catch (err) {
      if (isObjectStoreConnectivityError(err)) return replyObjectStoreUnreachable(reply);
      throw err;
    }
  });

  app.get("/api/attachments/:id", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const { id } = req.params as { id: string };
    const row = await loadAttachment(deps, ident.tenantId, id);
    if (!row) {
      return reply.code(404).send({ error: "not_found", message: `attachment ${id} not found` });
    }
    try {
      await ensureCached(deps, ident.tenantId, row);
      const filename = row.filename ?? "attachment.bin";
      const presigned = await deps.objectStore.presignGet(row.objectKey, {
        expiresInSeconds: 600,
        responseContentDisposition: `attachment; filename="${escapeFilename(filename)}"`,
        responseContentType: row.mime,
      });
      return { url: presigned.url, expiresAt: presigned.expiresAt };
    } catch (err) {
      if (isObjectStoreConnectivityError(err)) return replyObjectStoreUnreachable(reply);
      throw err;
    }
  });

  app.get("/api/attachments/:id/office-url", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const { id } = req.params as { id: string };
    const row = await loadAttachment(deps, ident.tenantId, id);
    if (!row) {
      return reply.code(404).send({ error: "not_found", message: `attachment ${id} not found` });
    }
    try {
      await ensureCached(deps, ident.tenantId, row);
      return {
        url: buildOfficeEditorUrl(
          prefixedObjectKey(row.objectKey),
          readSingleQueryValue((req.query as { from?: unknown }).from),
          row.filename ?? null,
          row.mime,
        ),
      };
    } catch (err) {
      if (isObjectStoreConnectivityError(err)) return replyObjectStoreUnreachable(reply);
      throw err;
    }
  });

  app.get("/api/attachments/:id/inline", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const { id } = req.params as { id: string };
    const row = await loadAttachment(deps, ident.tenantId, id);
    if (!row) {
      return reply.code(404).send({ error: "not_found", message: `attachment ${id} not found` });
    }
    try {
      await ensureCached(deps, ident.tenantId, row);
      const filename = row.filename ?? "inline.bin";
      const presigned = await deps.objectStore.presignGet(row.objectKey, {
        expiresInSeconds: 600,
        responseContentDisposition: `inline; filename="${escapeFilename(filename)}"`,
        responseContentType: row.mime,
      });
      return reply.header("cache-control", "private, max-age=600").redirect(presigned.url, 302);
    } catch (err) {
      if (isObjectStoreConnectivityError(err)) return replyObjectStoreUnreachable(reply);
      throw err;
    }
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

function prefixedObjectKey(objectKey: string): string {
  const prefix = (process.env["S3_KEY_PREFIX"] ?? "").replace(/^\/+|\/+$/g, "");
  if (!prefix) return objectKey;
  return `${prefix}/${objectKey.replace(/^\/+/, "")}`;
}

function buildOfficeEditorUrl(
  objectKey: string,
  from: string | null,
  filename: string | null,
  contentType: string | null,
): string {
  const base = (
    process.env["HOF_OS_PUBLIC_URL"] ??
    process.env["HOF_DATA_APP_PUBLIC_URL"] ??
    "http://localhost:3000"
  ).replace(/\/+$/, "");
  const url = new URL("/edit-asset", base);
  url.searchParams.set("key", objectKey);
  if (from) url.searchParams.set("from", from);
  if (filename?.trim()) url.searchParams.set("filename", filename.trim());
  if (contentType?.trim()) url.searchParams.set("content_type", contentType.trim());
  return url.toString();
}

function readSingleQueryValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value)) {
    const first = value.find((it): it is string => typeof it === "string" && it.trim().length > 0);
    return first ?? null;
  }
  return null;
}
