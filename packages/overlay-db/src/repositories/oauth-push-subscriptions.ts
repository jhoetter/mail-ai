// Repository for `oauth_push_subscriptions`.
//
// One row per OAuth account: holds the opaque
// providerSubscriptionId + the TTL the SyncScheduler has to renew
// within. Keyed by (tenant, account) so renewals UPDATE in place
// instead of accumulating leftover rows.

import { and, asc, eq, isNotNull, lte, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { oauthPushSubscriptions } from "../schema.js";

// Mirrors MailProviderId in @mailai/providers. Re-declared here so
// the overlay-db package stays free of provider-shape coupling.
export type PushSubscriptionProvider = "google-mail" | "outlook";

export interface PushSubscriptionRow {
  readonly id: string;
  readonly tenantId: string;
  readonly oauthAccountId: string;
  readonly provider: PushSubscriptionProvider;
  readonly providerSubscriptionId: string;
  readonly notificationUrl: string;
  readonly clientState: string;
  readonly opaqueState: string | null;
  readonly expiresAt: Date;
  readonly lastRenewedAt: Date | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PushSubscriptionUpsert {
  readonly id: string;
  readonly tenantId: string;
  readonly oauthAccountId: string;
  readonly provider: PushSubscriptionProvider;
  readonly providerSubscriptionId: string;
  readonly notificationUrl: string;
  readonly clientState: string;
  readonly opaqueState: string | null;
  readonly expiresAt: Date;
}

export class OauthPushSubscriptionsRepository {
  constructor(private readonly db: Database) {}

  // Idempotent upsert keyed on (tenant, account). A renewed
  // subscription that swaps the provider id ends up replacing the
  // row in place — the webhook router never sees stale entries.
  async upsert(row: PushSubscriptionUpsert): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO oauth_push_subscriptions (
        id, tenant_id, oauth_account_id, provider,
        provider_subscription_id, notification_url, client_state,
        opaque_state, expires_at, last_renewed_at, updated_at
      ) VALUES (
        ${row.id}, ${row.tenantId}, ${row.oauthAccountId}, ${row.provider},
        ${row.providerSubscriptionId}, ${row.notificationUrl}, ${row.clientState},
        ${row.opaqueState}, ${row.expiresAt.toISOString()}::timestamptz,
        now(), now()
      )
      ON CONFLICT (tenant_id, oauth_account_id) DO UPDATE SET
        provider = EXCLUDED.provider,
        provider_subscription_id = EXCLUDED.provider_subscription_id,
        notification_url = EXCLUDED.notification_url,
        client_state = EXCLUDED.client_state,
        opaque_state = EXCLUDED.opaque_state,
        expires_at = EXCLUDED.expires_at,
        last_renewed_at = now(),
        last_error = NULL,
        updated_at = now()
    `);
  }

  async byAccount(
    tenantId: string,
    oauthAccountId: string,
  ): Promise<PushSubscriptionRow | null> {
    const rows = await this.db
      .select()
      .from(oauthPushSubscriptions)
      .where(
        and(
          eq(oauthPushSubscriptions.tenantId, tenantId),
          eq(oauthPushSubscriptions.oauthAccountId, oauthAccountId),
        ),
      );
    return (rows[0] as PushSubscriptionRow | undefined) ?? null;
  }

  // Lookup by Graph clientState (echoed back on every webhook).
  async byClientState(
    tenantId: string,
    clientState: string,
  ): Promise<PushSubscriptionRow | null> {
    const rows = await this.db
      .select()
      .from(oauthPushSubscriptions)
      .where(
        and(
          eq(oauthPushSubscriptions.tenantId, tenantId),
          eq(oauthPushSubscriptions.clientState, clientState),
        ),
      );
    return (rows[0] as PushSubscriptionRow | undefined) ?? null;
  }

  // Lookup by Gmail Pub/Sub-supplied provider id. Used by the
  // webhook router; tenant-scoped to keep RLS honest.
  async byProviderSubscriptionId(
    tenantId: string,
    provider: PushSubscriptionProvider,
    providerSubscriptionId: string,
  ): Promise<PushSubscriptionRow | null> {
    const rows = await this.db
      .select()
      .from(oauthPushSubscriptions)
      .where(
        and(
          eq(oauthPushSubscriptions.tenantId, tenantId),
          eq(oauthPushSubscriptions.provider, provider),
          eq(
            oauthPushSubscriptions.providerSubscriptionId,
            providerSubscriptionId,
          ),
        ),
      );
    return (rows[0] as PushSubscriptionRow | undefined) ?? null;
  }

  // All subscriptions inside the renewal window for a tenant. The
  // scheduler tick uses this to find candidates without scanning the
  // whole table.
  async dueForRenewal(
    tenantId: string,
    horizon: Date,
  ): Promise<PushSubscriptionRow[]> {
    const rows = await this.db
      .select()
      .from(oauthPushSubscriptions)
      .where(
        and(
          eq(oauthPushSubscriptions.tenantId, tenantId),
          lte(oauthPushSubscriptions.expiresAt, horizon),
        ),
      )
      .orderBy(asc(oauthPushSubscriptions.expiresAt));
    return rows as PushSubscriptionRow[];
  }

  async listAll(tenantId: string): Promise<PushSubscriptionRow[]> {
    const rows = await this.db
      .select()
      .from(oauthPushSubscriptions)
      .where(eq(oauthPushSubscriptions.tenantId, tenantId))
      .orderBy(asc(oauthPushSubscriptions.expiresAt));
    return rows as PushSubscriptionRow[];
  }

  // Remove a subscription. Used after unsubscribe() succeeds, or
  // after a renew loop has exhausted retries.
  async deleteByAccount(
    tenantId: string,
    oauthAccountId: string,
  ): Promise<void> {
    await this.db
      .delete(oauthPushSubscriptions)
      .where(
        and(
          eq(oauthPushSubscriptions.tenantId, tenantId),
          eq(oauthPushSubscriptions.oauthAccountId, oauthAccountId),
        ),
      );
  }

  async markError(
    tenantId: string,
    oauthAccountId: string,
    error: string,
  ): Promise<void> {
    await this.db
      .update(oauthPushSubscriptions)
      .set({ lastError: error.slice(0, 500), updatedAt: new Date() })
      .where(
        and(
          eq(oauthPushSubscriptions.tenantId, tenantId),
          eq(oauthPushSubscriptions.oauthAccountId, oauthAccountId),
          isNotNull(oauthPushSubscriptions.providerSubscriptionId),
        ),
      );
  }
}
