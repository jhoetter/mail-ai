import { and, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { tags, threadTags } from "../schema.js";

export interface TagRow {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly color: string;
}

export class TagsRepository {
  constructor(private readonly db: Database) {}

  async upsert(row: TagRow): Promise<void> {
    await this.db
      .insert(tags)
      .values(row)
      .onConflictDoUpdate({ target: tags.id, set: { name: row.name, color: row.color } });
  }

  async addToThread(tenantId: string, threadId: string, tagId: string): Promise<void> {
    await this.db
      .insert(threadTags)
      .values({ tenantId, threadId, tagId })
      .onConflictDoNothing();
  }

  async removeFromThread(tenantId: string, threadId: string, tagId: string): Promise<void> {
    await this.db
      .delete(threadTags)
      .where(
        and(
          eq(threadTags.tenantId, tenantId),
          eq(threadTags.threadId, threadId),
          eq(threadTags.tagId, tagId),
        ),
      );
  }
}
