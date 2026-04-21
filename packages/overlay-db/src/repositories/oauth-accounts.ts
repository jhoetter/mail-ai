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

  async delete(tenantId: string, id: string): Promise<void> {
    await this.db
      .delete(oauthAccounts)
      .where(and(eq(oauthAccounts.tenantId, tenantId), eq(oauthAccounts.id, id)));
  }
}
