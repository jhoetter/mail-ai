import { and, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { attachmentsMeta } from "../schema.js";

export interface AttachmentRow {
  readonly id: string;
  readonly tenantId: string;
  readonly messageId: string;
  readonly filename: string | null;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly storageRef: string;
}

export class AttachmentsRepository {
  constructor(private readonly db: Database) {}

  async insert(row: AttachmentRow): Promise<void> {
    await this.db.insert(attachmentsMeta).values(row);
  }

  async listForMessage(tenantId: string, messageId: string): Promise<AttachmentRow[]> {
    const rows = await this.db
      .select()
      .from(attachmentsMeta)
      .where(and(eq(attachmentsMeta.tenantId, tenantId), eq(attachmentsMeta.messageId, messageId)));
    return rows as AttachmentRow[];
  }
}
