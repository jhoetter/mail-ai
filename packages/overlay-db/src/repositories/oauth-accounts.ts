// Repository for OAuth-connected mail accounts.
//
// Lives next to AccountsRepository (IMAP-credentialed accounts) and is
// kept narrow: just the fields needed to (a) display a connected
// account, (b) refresh the access token directly against the provider
// without going through Nango, and (c) drive future XOAUTH2 wiring in
// @mailai/imap-sync.

import { and, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { oauthAccounts } from "../schema.js";

export type OauthProvider = "google-mail" | "outlook";
export type OauthAccountStatus = "ok" | "needs-reauth" | "revoked";

export interface OauthAccountRow {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly provider: OauthProvider;
  readonly email: string;
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly tokenType: string;
  readonly scope: string | null;
  readonly expiresAt: Date | null;
  readonly nangoConnectionId: string | null;
  readonly nangoProviderConfigKey: string | null;
  readonly rawJson: unknown | null;
  readonly status: OauthAccountStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastRefreshedAt: Date | null;
  readonly lastSyncedAt: Date | null;
  readonly lastSyncError: string | null;
  readonly signatureHtml: string | null;
  readonly signatureText: string | null;
  // Provider delta watermarks (Phase 6). `historyId` is Gmail's
  // monotonic per-mailbox counter; `deltaLink` is Microsoft Graph's
  // opaque resume URL. Both are NULL until the first successful
  // delta-capable sync, and reset to NULL on 404/410 expiries.
  readonly historyId: string | null;
  readonly deltaLink: string | null;
}

export interface OauthAccountInsert {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly provider: OauthProvider;
  readonly email: string;
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly tokenType?: string;
  readonly scope: string | null;
  readonly expiresAt: Date | null;
  readonly nangoConnectionId: string | null;
  readonly nangoProviderConfigKey: string | null;
  readonly rawJson: unknown | null;
}

export interface OauthAccountTokenUpdate {
  readonly accessToken: string;
  readonly refreshToken?: string | null;
  readonly expiresAt: Date | null;
  readonly scope?: string | null;
  readonly status?: OauthAccountStatus;
}

export class OauthAccountsRepository {
  constructor(private readonly db: Database) {}

  async listByTenant(tenantId: string): Promise<OauthAccountRow[]> {
    const rows = await this.db
      .select()
      .from(oauthAccounts)
      .where(eq(oauthAccounts.tenantId, tenantId));
    return rows as OauthAccountRow[];
  }

  async byId(tenantId: string, id: string): Promise<OauthAccountRow | null> {
    const rows = await this.db
      .select()
      .from(oauthAccounts)
      .where(and(eq(oauthAccounts.tenantId, tenantId), eq(oauthAccounts.id, id)));
    return (rows[0] as OauthAccountRow | undefined) ?? null;
  }

  async byProviderEmail(
    tenantId: string,
    provider: OauthProvider,
    email: string,
  ): Promise<OauthAccountRow | null> {
    const rows = await this.db
      .select()
      .from(oauthAccounts)
      .where(
        and(
          eq(oauthAccounts.tenantId, tenantId),
          eq(oauthAccounts.provider, provider),
          eq(oauthAccounts.email, email),
        ),
      );
    return (rows[0] as OauthAccountRow | undefined) ?? null;
  }

  // Upsert by (tenant, provider, email) so re-connecting an account
  // refreshes the stored tokens rather than producing duplicates.
  async upsert(row: OauthAccountInsert): Promise<OauthAccountRow> {
    const existing = await this.byProviderEmail(row.tenantId, row.provider, row.email);
    const now = new Date();
    if (existing) {
      await this.db
        .update(oauthAccounts)
        .set({
          accessToken: row.accessToken,
          refreshToken: row.refreshToken,
          tokenType: row.tokenType ?? "Bearer",
          scope: row.scope,
          expiresAt: row.expiresAt,
          nangoConnectionId: row.nangoConnectionId,
          nangoProviderConfigKey: row.nangoProviderConfigKey,
          rawJson: row.rawJson as never,
          status: "ok",
          updatedAt: now,
          lastRefreshedAt: now,
        })
        .where(eq(oauthAccounts.id, existing.id));
      const updated = await this.byId(row.tenantId, existing.id);
      if (!updated) throw new Error("oauth-accounts: upsert update vanished");
      return updated;
    }
    await this.db.insert(oauthAccounts).values({
      id: row.id,
      tenantId: row.tenantId,
      userId: row.userId,
      provider: row.provider,
      email: row.email,
      accessToken: row.accessToken,
      refreshToken: row.refreshToken,
      tokenType: row.tokenType ?? "Bearer",
      scope: row.scope,
      expiresAt: row.expiresAt,
      nangoConnectionId: row.nangoConnectionId,
      nangoProviderConfigKey: row.nangoProviderConfigKey,
      rawJson: row.rawJson as never,
      status: "ok",
      createdAt: now,
      updatedAt: now,
      lastRefreshedAt: now,
    });
    const inserted = await this.byId(row.tenantId, row.id);
    if (!inserted) throw new Error("oauth-accounts: insert vanished");
    return inserted;
  }

  async updateTokens(
    tenantId: string,
    id: string,
    upd: OauthAccountTokenUpdate,
  ): Promise<void> {
    const now = new Date();
    const set: Record<string, unknown> = {
      accessToken: upd.accessToken,
      expiresAt: upd.expiresAt,
      updatedAt: now,
      lastRefreshedAt: now,
    };
    if (upd.refreshToken !== undefined) set["refreshToken"] = upd.refreshToken;
    if (upd.scope !== undefined) set["scope"] = upd.scope;
    if (upd.status !== undefined) set["status"] = upd.status;
    await this.db
      .update(oauthAccounts)
      .set(set as never)
      .where(and(eq(oauthAccounts.tenantId, tenantId), eq(oauthAccounts.id, id)));
  }

  async markStatus(
    tenantId: string,
    id: string,
    status: OauthAccountStatus,
  ): Promise<void> {
    await this.db
      .update(oauthAccounts)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(oauthAccounts.tenantId, tenantId), eq(oauthAccounts.id, id)));
  }

  // Used by /api/oauth/finalize when the verified address from the
  // provider differs from the placeholder (or earlier guess) we
  // persisted. Skips the unique index race by going through the same
  // (tenant, provider, email) lookup path as upsert.
  async updateEmail(tenantId: string, id: string, email: string): Promise<void> {
    await this.db
      .update(oauthAccounts)
      .set({ email, updatedAt: new Date() })
      .where(and(eq(oauthAccounts.tenantId, tenantId), eq(oauthAccounts.id, id)));
  }

  // Records the result of an initial / on-demand REST sync. `error`
  // is null on success; otherwise it's the truncated error message.
  async markSync(
    tenantId: string,
    id: string,
    args: { at: Date; error: string | null },
  ): Promise<void> {
    await this.db
      .update(oauthAccounts)
      .set({
        lastSyncedAt: args.at,
        lastSyncError: args.error,
        updatedAt: new Date(),
      })
      .where(and(eq(oauthAccounts.tenantId, tenantId), eq(oauthAccounts.id, id)));
  }

  // Persist the provider's delta watermark after a successful pull.
  // Either field may be passed independently — Gmail uses
  // `historyId`, Graph uses `deltaLink`. Passing `null` explicitly
  // clears the column (used when a 404/410 forces a re-baseline).
  async setWatermark(
    tenantId: string,
    id: string,
    args: { historyId?: string | null; deltaLink?: string | null },
  ): Promise<void> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (args.historyId !== undefined) set["historyId"] = args.historyId;
    if (args.deltaLink !== undefined) set["deltaLink"] = args.deltaLink;
    await this.db
      .update(oauthAccounts)
      .set(set as never)
      .where(and(eq(oauthAccounts.tenantId, tenantId), eq(oauthAccounts.id, id)));
  }

  // Persist a per-account signature edited via the Settings UI. Both
  // shapes are optional but at least one is expected to be set; the
  // composer wraps whichever is non-null in a `mailai-signature`
  // sentinel so future automation can strip it cleanly.
  async setSignature(
    tenantId: string,
    id: string,
    sig: { html: string | null; text: string | null },
  ): Promise<void> {
    await this.db
      .update(oauthAccounts)
      .set({
        signatureHtml: sig.html,
        signatureText: sig.text,
        updatedAt: new Date(),
      })
      .where(and(eq(oauthAccounts.tenantId, tenantId), eq(oauthAccounts.id, id)));
  }

  async delete(tenantId: string, id: string): Promise<void> {
    await this.db
      .delete(oauthAccounts)
      .where(and(eq(oauthAccounts.tenantId, tenantId), eq(oauthAccounts.id, id)));
  }

  // Remove any "placeholder" rows for this user+provider whose email
  // looks like the `<provider>-<connectionId>@unknown.local` fallback
  // we used before userinfo resolution. Called from /api/oauth/finalize
  // so reconnecting an account doesn't leave the broken row alongside
  // the now-correctly-named one (the unique index is on email, so a
  // simple upsert can't fix this case on its own).
  async deletePlaceholders(args: {
    tenantId: string;
    userId: string;
    provider: OauthProvider;
  }): Promise<number> {
    const rows = await this.db
      .select({ id: oauthAccounts.id, email: oauthAccounts.email })
      .from(oauthAccounts)
      .where(
        and(
          eq(oauthAccounts.tenantId, args.tenantId),
          eq(oauthAccounts.userId, args.userId),
          eq(oauthAccounts.provider, args.provider),
        ),
      );
    const placeholders = rows.filter((r) => r.email.endsWith("@unknown.local"));
    for (const r of placeholders) {
      await this.delete(args.tenantId, r.id);
    }
    return placeholders.length;
  }
}
