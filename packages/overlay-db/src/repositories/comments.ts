import { and, desc, eq, isNull } from "drizzle-orm";
import type { Database } from "../client.js";
import { comments } from "../schema.js";

export interface CommentRow {
  readonly id: string;
  readonly tenantId: string;
  readonly threadId: string;
  readonly authorId: string;
  readonly body: string;
  readonly mentionsJson: readonly string[];
  readonly createdAt: Date;
  readonly editedAt: Date | null;
  readonly deletedAt: Date | null;
}

export class CommentsRepository {
  constructor(private readonly db: Database) {}

  async listForThread(tenantId: string, threadId: string): Promise<CommentRow[]> {
    const rows = await this.db
      .select()
      .from(comments)
      .where(
        and(
          eq(comments.tenantId, tenantId),
          eq(comments.threadId, threadId),
          isNull(comments.deletedAt),
        ),
      )
      .orderBy(desc(comments.createdAt));
    return rows as unknown as CommentRow[];
  }

  async insert(row: CommentRow): Promise<void> {
    await this.db.insert(comments).values({
      id: row.id,
      tenantId: row.tenantId,
      threadId: row.threadId,
      authorId: row.authorId,
      body: row.body,
      mentionsJson: row.mentionsJson as unknown as object,
      createdAt: row.createdAt,
      editedAt: row.editedAt,
      deletedAt: row.deletedAt,
    });
  }

  async softDelete(tenantId: string, id: string): Promise<void> {
    await this.db
      .update(comments)
      .set({ deletedAt: new Date() })
      .where(and(eq(comments.tenantId, tenantId), eq(comments.id, id)));
  }
}
