// Repository for the per-user oauth_thread_state table.
//
// Status semantics:
//   - 'open' is implicit; rows aren't required for unread mail. We
//     only insert one when the user explicitly snoozes or marks done.
//   - 'snoozed' carries snoozed_until; the views layer wakes rows up
//     by running a single UPDATE on every read of an open or snoozed
//     view (cheap, no worker needed for v1).
//   - 'done' carries done_at for "Done in the last week" sorting.

import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { oauthThreadState } from "../schema.js";

export type OauthThreadStatus = "open" | "snoozed" | "done";
// Local alias kept for legacy callers; will be cleaned up in Phase 6.
export type ThreadStateStatus = OauthThreadStatus;

export interface OauthThreadStateRow {
  readonly tenantId: string;
  readonly userId: string;
  readonly providerThreadId: string;
  readonly status: OauthThreadStatus;
  readonly snoozedUntil: Date | null;
  readonly doneAt: Date | null;
  readonly updatedAt: Date;
}

export class OauthThreadStateRepository {
  constructor(private readonly db: Database) {}

  async get(
    tenantId: string,
    userId: string,
    providerThreadId: string,
  ): Promise<OauthThreadStateRow | null> {
    const rows = await this.db
      .select()
      .from(oauthThreadState)
      .where(
        and(
          eq(oauthThreadState.tenantId, tenantId),
          eq(oauthThreadState.userId, userId),
          eq(oauthThreadState.providerThreadId, providerThreadId),
        ),
      );
    return (rows[0] as OauthThreadStateRow | undefined) ?? null;
  }

  async snooze(
    tenantId: string,
    userId: string,
    providerThreadId: string,
    until: Date,
  ): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO oauth_thread_state (
        tenant_id, user_id, provider_thread_id, status, snoozed_until, updated_at
      ) VALUES (
        ${tenantId}, ${userId}, ${providerThreadId}, 'snoozed',
        ${until.toISOString()}::timestamptz, now()
      )
      ON CONFLICT (tenant_id, user_id, provider_thread_id) DO UPDATE SET
        status = 'snoozed',
        snoozed_until = EXCLUDED.snoozed_until,
        done_at = NULL,
        updated_at = now()
    `);
  }

  async unsnooze(tenantId: string, userId: string, providerThreadId: string): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO oauth_thread_state (
        tenant_id, user_id, provider_thread_id, status, updated_at
      ) VALUES (
        ${tenantId}, ${userId}, ${providerThreadId}, 'open', now()
      )
      ON CONFLICT (tenant_id, user_id, provider_thread_id) DO UPDATE SET
        status = 'open',
        snoozed_until = NULL,
        updated_at = now()
    `);
  }

  async markDone(tenantId: string, userId: string, providerThreadId: string): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO oauth_thread_state (
        tenant_id, user_id, provider_thread_id, status, done_at, updated_at
      ) VALUES (
        ${tenantId}, ${userId}, ${providerThreadId}, 'done', now(), now()
      )
      ON CONFLICT (tenant_id, user_id, provider_thread_id) DO UPDATE SET
        status = 'done',
        done_at = now(),
        snoozed_until = NULL,
        updated_at = now()
    `);
  }

  async reopen(tenantId: string, userId: string, providerThreadId: string): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO oauth_thread_state (
        tenant_id, user_id, provider_thread_id, status, updated_at
      ) VALUES (
        ${tenantId}, ${userId}, ${providerThreadId}, 'open', now()
      )
      ON CONFLICT (tenant_id, user_id, provider_thread_id) DO UPDATE SET
        status = 'open',
        snoozed_until = NULL,
        done_at = NULL,
        updated_at = now()
    `);
  }

  // Wake every snoozed thread whose snoozed_until has passed for this
  // user. Returns the count for diagnostics. Run before every read of
  // a status=open or status=snoozed view.
  async wakeUpExpired(tenantId: string, userId: string, now: Date): Promise<number> {
    const res = await this.db.execute(sql`
      UPDATE oauth_thread_state
      SET status = 'open', snoozed_until = NULL, updated_at = now()
      WHERE tenant_id = ${tenantId}
        AND user_id = ${userId}
        AND status = 'snoozed'
        AND snoozed_until <= ${now.toISOString()}::timestamptz
    `);
    return (res.rowCount ?? 0) as number;
  }

  async listByStatus(
    tenantId: string,
    userId: string,
    status: OauthThreadStatus,
  ): Promise<OauthThreadStateRow[]> {
    const rows = await this.db
      .select()
      .from(oauthThreadState)
      .where(
        and(
          eq(oauthThreadState.tenantId, tenantId),
          eq(oauthThreadState.userId, userId),
          eq(oauthThreadState.status, status),
        ),
      );
    return rows as OauthThreadStateRow[];
  }

  // Bulk fetch state for many threads in one query, keyed by
  // provider_thread_id. Used by the inbox list to render status
  // chips without N+1 round trips.
  async byUserAndThreads(
    tenantId: string,
    userId: string,
    providerThreadIds: readonly string[],
  ): Promise<Map<string, OauthThreadStateRow>> {
    const out = new Map<string, OauthThreadStateRow>();
    if (providerThreadIds.length === 0) return out;
    const rows = await this.db
      .select()
      .from(oauthThreadState)
      .where(
        and(
          eq(oauthThreadState.tenantId, tenantId),
          eq(oauthThreadState.userId, userId),
          inArray(oauthThreadState.providerThreadId, providerThreadIds as string[]),
        ),
      );
    for (const r of rows as OauthThreadStateRow[]) {
      out.set(r.providerThreadId, r);
    }
    return out;
  }

  async listSnoozedDueBy(
    tenantId: string,
    userId: string,
    cutoff: Date,
  ): Promise<OauthThreadStateRow[]> {
    const rows = await this.db
      .select()
      .from(oauthThreadState)
      .where(
        and(
          eq(oauthThreadState.tenantId, tenantId),
          eq(oauthThreadState.userId, userId),
          eq(oauthThreadState.status, "snoozed"),
          lte(oauthThreadState.snoozedUntil, cutoff),
        ),
      );
    return rows as OauthThreadStateRow[];
  }
}
