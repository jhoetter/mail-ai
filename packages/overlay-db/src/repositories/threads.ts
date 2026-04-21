import { and, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { threads } from "../schema.js";

export type ThreadStatus = "open" | "snoozed" | "resolved" | "archived";

export interface ThreadRow {
  readonly id: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly rootMessageId: string | null;
  readonly subject: string | null;
  readonly status: ThreadStatus;
  readonly snoozedUntil: Date | null;
  readonly assignedTo: string | null;
  readonly lastMessageAt: Date;
}

export class ThreadsRepository {
  constructor(private readonly db: Database) {}

  async byId(tenantId: string, id: string): Promise<ThreadRow | null> {
    const rows = await this.db
      .select()
      .from(threads)
      .where(and(eq(threads.tenantId, tenantId), eq(threads.id, id)));
    return (rows[0] as ThreadRow | undefined) ?? null;
  }

  async upsert(row: ThreadRow): Promise<void> {
    await this.db
      .insert(threads)
      .values(row)
      .onConflictDoUpdate({
        target: threads.id,
        set: {
          subject: row.subject,
          status: row.status,
          snoozedUntil: row.snoozedUntil,
          assignedTo: row.assignedTo,
          lastMessageAt: row.lastMessageAt,
        },
      });
  }

  async setStatus(tenantId: string, id: string, status: ThreadStatus): Promise<void> {
    await this.db
      .update(threads)
      .set({ status })
      .where(and(eq(threads.tenantId, tenantId), eq(threads.id, id)));
  }

  async assign(tenantId: string, id: string, assignee: string | null): Promise<void> {
    await this.db
      .update(threads)
      .set({ assignedTo: assignee })
      .where(and(eq(threads.tenantId, tenantId), eq(threads.id, id)));
  }
}
