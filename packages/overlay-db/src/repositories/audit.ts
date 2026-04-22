import { and, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { auditLog } from "../schema.js";
import type { Mutation } from "@mailai/core";

export interface AuditListFilter {
  readonly tenantId: string;
  readonly actor?: string;
  readonly type?: string;
  // Filter by anything inside payload_json.threadId — most of our
  // commands carry that key, so it's a useful pivot for "what did we
  // do to this thread?".
  readonly threadId?: string;
  readonly since?: Date;
  readonly until?: Date;
  // Cursor is the `seq` of the last row from the previous page; the
  // next page is everything BEFORE it (smaller seq), oldest-first
  // ordering inverted to keep the newest entries on page 1.
  readonly cursor?: bigint;
  readonly limit?: number;
}

export interface AuditRow {
  readonly seq: string;
  readonly tenantId: string;
  readonly mutationId: string;
  readonly commandType: string;
  readonly actorId: string;
  readonly source: string;
  readonly payloadJson: unknown;
  readonly diffJson: unknown;
  readonly status: string;
  readonly createdAt: Date;
}

export interface AuditPage {
  readonly items: readonly AuditRow[];
  readonly nextCursor: string | null;
}

export class AuditRepository {
  constructor(private readonly db: Database) {}

  async append(tenantId: string, mutation: Mutation): Promise<void> {
    await this.db.insert(auditLog).values({
      tenantId,
      mutationId: mutation.id,
      commandType: mutation.command.type,
      actorId: mutation.command.actorId,
      source: mutation.command.source,
      payloadJson: mutation.command.payload as object,
      diffJson: mutation.diffs as unknown as object,
      status: mutation.status,
    });
  }

  async list(filter: AuditListFilter): Promise<AuditPage> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const conds = [eq(auditLog.tenantId, filter.tenantId)];
    if (filter.actor) conds.push(eq(auditLog.actorId, filter.actor));
    if (filter.type) conds.push(eq(auditLog.commandType, filter.type));
    if (filter.since) conds.push(gte(auditLog.createdAt, filter.since));
    if (filter.until) conds.push(lte(auditLog.createdAt, filter.until));
    if (filter.cursor !== undefined) conds.push(lt(auditLog.seq, filter.cursor));
    if (filter.threadId) {
      // jsonb path filter; safe — value is a string parameter.
      conds.push(sql`${auditLog.payloadJson} ->> 'threadId' = ${filter.threadId}`);
    }

    // Fetch one extra row to detect if there's a next page.
    const rows = await this.db
      .select()
      .from(auditLog)
      .where(and(...conds))
      .orderBy(desc(auditLog.seq))
      .limit(limit + 1);

    const trimmed = rows.slice(0, limit) as unknown as AuditRow[];
    const hasMore = rows.length > limit;
    const last = trimmed[trimmed.length - 1];
    const nextCursor = hasMore && last ? String(last.seq) : null;
    return { items: trimmed, nextCursor };
  }
}

