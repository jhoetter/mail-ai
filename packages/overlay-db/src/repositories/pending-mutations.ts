import { and, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { pendingMutations } from "../schema.js";

export interface PendingRow {
  readonly id: string;
  readonly tenantId: string;
  readonly commandType: string;
  readonly actorId: string;
  readonly source: string;
  readonly payloadJson: unknown;
  readonly targetThreadId: string | null;
  readonly createdAt: Date;
  readonly status: "pending" | "approved" | "rejected";
  readonly rejectedReason: string | null;
}

export class PendingMutationsRepository {
  constructor(private readonly db: Database) {}

  async insert(row: PendingRow): Promise<void> {
    await this.db.insert(pendingMutations).values({
      id: row.id,
      tenantId: row.tenantId,
      commandType: row.commandType,
      actorId: row.actorId,
      source: row.source,
      payloadJson: row.payloadJson as object,
      targetThreadId: row.targetThreadId,
      createdAt: row.createdAt,
      status: row.status,
      rejectedReason: row.rejectedReason,
    });
  }

  async listPending(tenantId: string): Promise<PendingRow[]> {
    const rows = await this.db
      .select()
      .from(pendingMutations)
      .where(and(eq(pendingMutations.tenantId, tenantId), eq(pendingMutations.status, "pending")));
    return rows as unknown as PendingRow[];
  }

  async setStatus(
    tenantId: string,
    id: string,
    status: "approved" | "rejected",
    rejectedReason: string | null = null,
  ): Promise<void> {
    await this.db
      .update(pendingMutations)
      .set({ status, rejectedReason })
      .where(and(eq(pendingMutations.tenantId, tenantId), eq(pendingMutations.id, id)));
  }
}
