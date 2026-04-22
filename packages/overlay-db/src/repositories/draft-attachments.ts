// Repository for in-flight composer uploads.
//
// A row is created the moment the browser finishes a presigned PUT
// against S3 (`attachment:upload-finalise`). On send we copy/rename
// the bytes into the message namespace, mirror the metadata into
// `oauth_attachments`, and delete the staging row.
//
// `draftId` is nullable so unbound staging rows (composer is open but
// no Draft has been created yet) can still be tracked by user; on
// discard we cascade-delete via the FK once the draft id is set, or
// run a periodic janitor over user-scoped orphans.

import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../client.js";
import { draftAttachments } from "../schema.js";

export interface DraftAttachmentRow {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly draftId: string | null;
  readonly objectKey: string;
  readonly filename: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly createdAt: Date;
}

export interface DraftAttachmentInsert {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly draftId: string | null;
  readonly objectKey: string;
  readonly filename: string;
  readonly mime: string;
  readonly sizeBytes: number;
}

export class DraftAttachmentsRepository {
  constructor(private readonly db: Database) {}

  async insert(row: DraftAttachmentInsert): Promise<DraftAttachmentRow> {
    await this.db.insert(draftAttachments).values(row);
    const got = await this.byId(row.tenantId, row.id);
    if (!got) throw new Error("draft-attachments: insert vanished");
    return got;
  }

  async byId(tenantId: string, id: string): Promise<DraftAttachmentRow | null> {
    const rows = await this.db
      .select()
      .from(draftAttachments)
      .where(and(eq(draftAttachments.tenantId, tenantId), eq(draftAttachments.id, id)));
    return (rows[0] as DraftAttachmentRow | undefined) ?? null;
  }

  async listForDraft(tenantId: string, draftId: string): Promise<DraftAttachmentRow[]> {
    const rows = await this.db
      .select()
      .from(draftAttachments)
      .where(
        and(
          eq(draftAttachments.tenantId, tenantId),
          eq(draftAttachments.draftId, draftId),
        ),
      );
    return rows as DraftAttachmentRow[];
  }

  async listUnboundForUser(
    tenantId: string,
    userId: string,
  ): Promise<DraftAttachmentRow[]> {
    const rows = await this.db
      .select()
      .from(draftAttachments)
      .where(
        and(
          eq(draftAttachments.tenantId, tenantId),
          eq(draftAttachments.userId, userId),
          isNull(draftAttachments.draftId),
        ),
      );
    return rows as DraftAttachmentRow[];
  }

  async bindToDraft(tenantId: string, id: string, draftId: string): Promise<void> {
    await this.db
      .update(draftAttachments)
      .set({ draftId })
      .where(and(eq(draftAttachments.tenantId, tenantId), eq(draftAttachments.id, id)));
  }

  async delete(tenantId: string, id: string): Promise<void> {
    await this.db
      .delete(draftAttachments)
      .where(and(eq(draftAttachments.tenantId, tenantId), eq(draftAttachments.id, id)));
  }

  async deleteForDraft(tenantId: string, draftId: string): Promise<void> {
    await this.db
      .delete(draftAttachments)
      .where(
        and(
          eq(draftAttachments.tenantId, tenantId),
          eq(draftAttachments.draftId, draftId),
        ),
      );
  }
}
