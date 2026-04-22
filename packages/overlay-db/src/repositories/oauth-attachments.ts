// Repository for the OAuth-message attachments index.
//
// Distinct from AttachmentsRepository (which sits next to the IMAP
// `attachments_meta` table). This one is keyed off the provider's
// own message ids and powers:
//
//   - GET /api/attachments/:id   (presigned download)
//   - cid: rewriting in HtmlBody
//   - the AttachmentTray rendered in ThreadView
//   - hasAttachments flag maintenance on oauth_messages
//
// Bytes always live in S3 at `objectKey`; this row is metadata only.

import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { oauthAttachments } from "../schema.js";

export interface OauthAttachmentRow {
  readonly id: string;
  readonly tenantId: string;
  readonly oauthAccountId: string;
  readonly providerMessageId: string;
  readonly providerAttachmentId: string | null;
  readonly objectKey: string;
  readonly filename: string | null;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly contentId: string | null;
  readonly isInline: boolean;
  readonly cachedAt: Date | null;
  readonly createdAt: Date;
}

export interface OauthAttachmentInsert {
  readonly id: string;
  readonly tenantId: string;
  readonly oauthAccountId: string;
  readonly providerMessageId: string;
  readonly providerAttachmentId: string | null;
  readonly objectKey: string;
  readonly filename: string | null;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly contentId: string | null;
  readonly isInline: boolean;
}

export class OauthAttachmentsRepository {
  constructor(private readonly db: Database) {}

  async insert(row: OauthAttachmentInsert): Promise<OauthAttachmentRow> {
    await this.db.insert(oauthAttachments).values(row);
    const got = await this.byId(row.tenantId, row.id);
    if (!got) throw new Error("oauth-attachments: insert vanished");
    return got;
  }

  // Idempotent: if a row already exists for (account, providerMessageId,
  // providerAttachmentId|contentId|filename), we keep the existing id so
  // the API URL remains stable across re-syncs.
  async upsertForMessage(row: OauthAttachmentInsert): Promise<OauthAttachmentRow> {
    const existing = await this.findByProviderHandle({
      tenantId: row.tenantId,
      oauthAccountId: row.oauthAccountId,
      providerMessageId: row.providerMessageId,
      providerAttachmentId: row.providerAttachmentId,
      contentId: row.contentId,
      filename: row.filename,
    });
    if (existing) {
      await this.db
        .update(oauthAttachments)
        .set({
          providerAttachmentId: row.providerAttachmentId,
          objectKey: row.objectKey,
          filename: row.filename,
          mime: row.mime,
          sizeBytes: row.sizeBytes,
          contentId: row.contentId,
          isInline: row.isInline,
        })
        .where(eq(oauthAttachments.id, existing.id));
      const got = await this.byId(row.tenantId, existing.id);
      if (!got) throw new Error("oauth-attachments: upsert vanished");
      return got;
    }
    return this.insert(row);
  }

  async byId(tenantId: string, id: string): Promise<OauthAttachmentRow | null> {
    const rows = await this.db
      .select()
      .from(oauthAttachments)
      .where(and(eq(oauthAttachments.tenantId, tenantId), eq(oauthAttachments.id, id)));
    return (rows[0] as OauthAttachmentRow | undefined) ?? null;
  }

  async listForMessage(
    tenantId: string,
    oauthAccountId: string,
    providerMessageId: string,
  ): Promise<OauthAttachmentRow[]> {
    const rows = await this.db
      .select()
      .from(oauthAttachments)
      .where(
        and(
          eq(oauthAttachments.tenantId, tenantId),
          eq(oauthAttachments.oauthAccountId, oauthAccountId),
          eq(oauthAttachments.providerMessageId, providerMessageId),
        ),
      )
      .orderBy(desc(oauthAttachments.createdAt));
    return rows as OauthAttachmentRow[];
  }

  // Used by the cid: rewrite path in HtmlBody. We narrow to the same
  // message because some providers reuse content-ids across threads.
  async findInlineByCid(
    tenantId: string,
    oauthAccountId: string,
    providerMessageId: string,
    contentId: string,
  ): Promise<OauthAttachmentRow | null> {
    const rows = await this.db
      .select()
      .from(oauthAttachments)
      .where(
        and(
          eq(oauthAttachments.tenantId, tenantId),
          eq(oauthAttachments.oauthAccountId, oauthAccountId),
          eq(oauthAttachments.providerMessageId, providerMessageId),
          eq(oauthAttachments.contentId, contentId),
        ),
      );
    return (rows[0] as OauthAttachmentRow | undefined) ?? null;
  }

  async markCached(tenantId: string, id: string): Promise<void> {
    await this.db
      .update(oauthAttachments)
      .set({ cachedAt: new Date() })
      .where(and(eq(oauthAttachments.tenantId, tenantId), eq(oauthAttachments.id, id)));
  }

  private async findByProviderHandle(args: {
    tenantId: string;
    oauthAccountId: string;
    providerMessageId: string;
    providerAttachmentId: string | null;
    contentId: string | null;
    filename: string | null;
  }): Promise<OauthAttachmentRow | null> {
    const rows = await this.listForMessage(
      args.tenantId,
      args.oauthAccountId,
      args.providerMessageId,
    );
    // Provider attachment id is the strongest match key when present;
    // otherwise we fall back to (cid, filename) so re-syncs that lose
    // the original id (rare, but Graph paginates) still find the row.
    return (
      rows.find((r) =>
        args.providerAttachmentId
          ? r.providerAttachmentId === args.providerAttachmentId
          : r.contentId === args.contentId && r.filename === args.filename,
      ) ?? null
    );
  }
}
