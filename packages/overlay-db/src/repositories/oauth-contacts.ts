// Repository for the per-account address book cache. The suggest
// endpoint hits this table on every keystroke (debounced), so the
// query path has to stay sub-50ms even with many thousands of rows;
// see migration 0016_oauth_contacts for the indexes that make that
// possible (`oauth_contacts_tenant_email_idx` for prefix lookups,
// `oauth_contacts_trgm_idx` for substring fallbacks).

import { sql } from "drizzle-orm";
import type { Database } from "../client.js";

export type OauthContactProvider = "google-mail" | "outlook";
export type OauthContactSource = "my" | "other" | "people";

export interface OauthContactEmail {
  readonly address: string;
  readonly type?: string;
  readonly primary?: boolean;
}

export interface OauthContactRow {
  readonly id: string;
  readonly tenantId: string;
  readonly oauthAccountId: string;
  readonly provider: OauthContactProvider;
  readonly providerContactId: string;
  readonly source: OauthContactSource;
  readonly displayName: string | null;
  readonly primaryEmail: string;
  readonly emailsJson: OauthContactEmail[];
  readonly lastInteractionAt: Date | null;
  readonly fetchedAt: Date;
}

export interface OauthContactInsert {
  readonly id: string;
  readonly tenantId: string;
  readonly oauthAccountId: string;
  readonly provider: OauthContactProvider;
  readonly providerContactId: string;
  readonly source: OauthContactSource;
  readonly displayName: string | null;
  readonly primaryEmail: string;
  readonly emails: OauthContactEmail[];
  readonly lastInteractionAt?: Date | null;
}

export interface ContactSuggestion {
  readonly id: string;
  readonly displayName: string | null;
  readonly email: string;
  readonly source: OauthContactSource;
  readonly oauthAccountId: string;
  readonly lastInteractionAt: Date | null;
}

export interface SearchContactsArgs {
  readonly tenantId: string;
  readonly oauthAccountId?: string | null;
  readonly q: string;
  readonly limit?: number;
}

export interface FreshnessRow {
  readonly oauthAccountId: string;
  readonly source: OauthContactSource;
  readonly fetchedAt: Date;
}

export class OauthContactsRepository {
  constructor(private readonly db: Database) {}

  // Idempotent batch upsert keyed on (oauth_account_id,
  // provider_contact_id). The unique index keeps re-running a sync
  // over the same window from producing duplicates and lets us
  // refresh display_name / emails / last_interaction_at as the
  // provider's view evolves.
  async upsertMany(rows: OauthContactInsert[]): Promise<void> {
    if (rows.length === 0) return;
    for (const r of rows) {
      const primaryEmail = r.primaryEmail.trim().toLowerCase();
      if (!primaryEmail) continue;
      await this.db.execute(sql`
        INSERT INTO oauth_contacts (
          id, tenant_id, oauth_account_id, provider,
          provider_contact_id, source,
          display_name, primary_email, emails_json,
          last_interaction_at, fetched_at
        ) VALUES (
          ${r.id}, ${r.tenantId}, ${r.oauthAccountId}, ${r.provider},
          ${r.providerContactId}, ${r.source},
          ${r.displayName}, ${primaryEmail},
          ${JSON.stringify(r.emails)}::jsonb,
          ${r.lastInteractionAt ? r.lastInteractionAt.toISOString() : null}::timestamptz,
          now()
        )
        ON CONFLICT (oauth_account_id, provider_contact_id) DO UPDATE SET
          source = EXCLUDED.source,
          display_name = EXCLUDED.display_name,
          primary_email = EXCLUDED.primary_email,
          emails_json = EXCLUDED.emails_json,
          last_interaction_at = COALESCE(EXCLUDED.last_interaction_at, oauth_contacts.last_interaction_at),
          fetched_at = now()
      `);
    }
  }

  // Drop rows for (account, source) whose providerContactId is no
  // longer present in the latest snapshot. Lets a deleted contact
  // disappear from autocomplete on the next sync without us having
  // to track tombstones provider-side.
  async deleteMissing(args: {
    oauthAccountId: string;
    source: OauthContactSource;
    keepProviderContactIds: readonly string[];
  }): Promise<number> {
    if (args.keepProviderContactIds.length === 0) {
      const res = await this.db.execute(sql`
        DELETE FROM oauth_contacts
        WHERE oauth_account_id = ${args.oauthAccountId}
          AND source = ${args.source}
      `);
      return res.rowCount ?? 0;
    }
    const res = await this.db.execute(sql`
      DELETE FROM oauth_contacts
      WHERE oauth_account_id = ${args.oauthAccountId}
        AND source = ${args.source}
        AND provider_contact_id <> ALL(${args.keepProviderContactIds}::text[])
    `);
    return res.rowCount ?? 0;
  }

  // Newest fetched_at per (account, source). Used by the suggest
  // route to decide whether to kick a background refresh — if the
  // newest row for an account is older than the freshness window we
  // dispatch a sync without blocking the response.
  async freshness(tenantId: string): Promise<FreshnessRow[]> {
    const res = await this.db.execute<{
      oauth_account_id: string;
      source: string;
      fetched_at: Date;
    }>(sql`
      SELECT oauth_account_id, source, max(fetched_at) AS fetched_at
      FROM oauth_contacts
      WHERE tenant_id = ${tenantId}
      GROUP BY oauth_account_id, source
    `);
    return (res.rows ?? []).map((r) => ({
      oauthAccountId: r.oauth_account_id,
      source: r.source as OauthContactSource,
      fetchedAt: new Date(r.fetched_at),
    }));
  }

  // Prefix-and-substring search with a deterministic ranking:
  //
  //   1. Exact email prefix match  (q at the start of primary_email)
  //   2. Display-name word-prefix  (q at start of any whitespace-
  //                                  separated token in display_name)
  //   3. Substring match anywhere in display_name or primary_email
  //
  // Tie-break by lastInteractionAt desc, then source ('my' beats
  // 'people' beats 'other') so explicit address-book entries win
  // over auto-collected ones at the same recency.
  async searchContacts(args: SearchContactsArgs): Promise<ContactSuggestion[]> {
    const limit = Math.min(Math.max(args.limit ?? 8, 1), 20);
    const q = args.q.trim().toLowerCase();
    if (!q) return [];
    const prefix = `${escapeLike(q)}%`;
    const wordPrefix = `% ${escapeLike(q)}%`;
    const substring = `%${escapeLike(q)}%`;

    const accountFilter = args.oauthAccountId
      ? sql`AND oauth_account_id = ${args.oauthAccountId}`
      : sql``;

    const res = await this.db.execute<{
      id: string;
      display_name: string | null;
      primary_email: string;
      source: string;
      oauth_account_id: string;
      last_interaction_at: Date | null;
    }>(sql`
      SELECT id, display_name, primary_email, source, oauth_account_id, last_interaction_at,
        CASE
          WHEN primary_email LIKE ${prefix} ESCAPE '\\' THEN 1
          WHEN lower(coalesce(display_name,'')) LIKE ${prefix} ESCAPE '\\' THEN 2
          WHEN lower(coalesce(display_name,'')) LIKE ${wordPrefix} ESCAPE '\\' THEN 3
          ELSE 4
        END AS rank
      FROM oauth_contacts
      WHERE tenant_id = ${args.tenantId}
        ${accountFilter}
        AND (
          primary_email LIKE ${substring} ESCAPE '\\'
          OR lower(coalesce(display_name,'')) LIKE ${substring} ESCAPE '\\'
        )
      ORDER BY rank ASC,
        last_interaction_at DESC NULLS LAST,
        CASE source WHEN 'my' THEN 0 WHEN 'people' THEN 1 ELSE 2 END ASC,
        primary_email ASC
      LIMIT ${limit}
    `);

    return (res.rows ?? []).map((r) => ({
      id: r.id,
      displayName: r.display_name,
      email: r.primary_email,
      source: r.source as OauthContactSource,
      oauthAccountId: r.oauth_account_id,
      lastInteractionAt: r.last_interaction_at ? new Date(r.last_interaction_at) : null,
    }));
  }
}

// LIKE-escape so a literal underscore or percent in the query doesn't
// silently widen the match. We use '\' as the escape char and quote
// it explicitly via `ESCAPE '\\'` in the queries above.
//
// Exported for tests; not part of the public surface anyone should
// reach for from outside the repo.
export function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}
