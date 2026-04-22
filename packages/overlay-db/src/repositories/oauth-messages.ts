// Repository for the lightweight OAuth-message store.
//
// Distinct from MessagesRepository (which is IMAP-shaped: integer uid,
// rawRef in S3, jsonb addresses, …). This table holds just the metadata
// the inbox UI needs after a Gmail/Graph REST sync, keyed by the
// provider's own message id. See migration 0006_oauth_messages.

import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { oauthMessages } from "../schema.js";

export type OauthMessageProvider = "google-mail" | "outlook";

export interface OauthMessageRow {
  readonly id: string;
  readonly tenantId: string;
  readonly oauthAccountId: string;
  readonly provider: OauthMessageProvider;
  readonly providerMessageId: string;
  readonly providerThreadId: string;
  readonly subject: string | null;
  readonly fromName: string | null;
  readonly fromEmail: string | null;
  readonly toAddr: string | null;
  readonly snippet: string;
  readonly internalDate: Date;
  readonly labelsJson: string[];
  readonly unread: boolean;
  readonly fetchedAt: Date;
  readonly bodyText: string | null;
  readonly bodyHtml: string | null;
  readonly bodyFetchedAt: Date | null;
  readonly hasAttachments: boolean;
  readonly starred: boolean;
}

export interface OauthMessageInsert {
  readonly id: string;
  readonly tenantId: string;
  readonly oauthAccountId: string;
  readonly provider: OauthMessageProvider;
  readonly providerMessageId: string;
  readonly providerThreadId: string;
  readonly subject: string | null;
  readonly fromName: string | null;
  readonly fromEmail: string | null;
  readonly toAddr: string | null;
  readonly snippet: string;
  readonly internalDate: Date;
  readonly labelsJson: string[];
  readonly unread: boolean;
}

export class OauthMessagesRepository {
  constructor(private readonly db: Database) {}

  // Idempotent batch upsert keyed on (oauth_account_id,
  // provider_message_id). Re-running a sync over the same window must
  // never produce duplicates and must update unread/labels/snippet to
  // reflect what the provider currently says.
  async upsertMany(rows: OauthMessageInsert[]): Promise<{ inserted: number; updated: number }> {
    if (rows.length === 0) return { inserted: 0, updated: 0 };
    let inserted = 0;
    let updated = 0;
    for (const r of rows) {
      // ON CONFLICT here keeps things atomic and lets us count which
      // path was taken via xmax (0 = insert, non-zero = update).
      const result = await this.db.execute(sql`
        INSERT INTO oauth_messages (
          id, tenant_id, oauth_account_id, provider,
          provider_message_id, provider_thread_id,
          subject, from_name, from_email, to_addr,
          snippet, internal_date, labels_json, unread, fetched_at
        ) VALUES (
          ${r.id}, ${r.tenantId}, ${r.oauthAccountId}, ${r.provider},
          ${r.providerMessageId}, ${r.providerThreadId},
          ${r.subject}, ${r.fromName}, ${r.fromEmail}, ${r.toAddr},
          ${r.snippet}, ${r.internalDate.toISOString()}::timestamptz,
          ${JSON.stringify(r.labelsJson)}::jsonb, ${r.unread}, now()
        )
        ON CONFLICT (oauth_account_id, provider_message_id) DO UPDATE SET
          subject = EXCLUDED.subject,
          from_name = EXCLUDED.from_name,
          from_email = EXCLUDED.from_email,
          to_addr = EXCLUDED.to_addr,
          snippet = EXCLUDED.snippet,
          labels_json = EXCLUDED.labels_json,
          unread = EXCLUDED.unread,
          fetched_at = now()
        RETURNING (xmax = 0) AS inserted
      `);
      const wasInsert = (result.rows?.[0] as { inserted?: boolean } | undefined)?.inserted === true;
      if (wasInsert) inserted += 1;
      else updated += 1;
    }
    return { inserted, updated };
  }

  async listByTenant(
    tenantId: string,
    opts: { limit?: number } = {},
  ): Promise<OauthMessageRow[]> {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const rows = await this.db
      .select()
      .from(oauthMessages)
      .where(eq(oauthMessages.tenantId, tenantId))
      .orderBy(desc(oauthMessages.internalDate))
      .limit(limit);
    return rows as OauthMessageRow[];
  }

  async listByAccount(
    tenantId: string,
    oauthAccountId: string,
    opts: { limit?: number } = {},
  ): Promise<OauthMessageRow[]> {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const rows = await this.db
      .select()
      .from(oauthMessages)
      .where(
        and(
          eq(oauthMessages.tenantId, tenantId),
          eq(oauthMessages.oauthAccountId, oauthAccountId),
        ),
      )
      .orderBy(desc(oauthMessages.internalDate))
      .limit(limit);
    return rows as OauthMessageRow[];
  }

  async countByTenant(tenantId: string): Promise<number> {
    const result = await this.db.execute(sql`
      SELECT count(*)::int AS n FROM oauth_messages WHERE tenant_id = ${tenantId}
    `);
    const n = (result.rows?.[0] as { n?: number } | undefined)?.n;
    return typeof n === "number" ? n : 0;
  }

  async byId(tenantId: string, id: string): Promise<OauthMessageRow | null> {
    const rows = await this.db
      .select()
      .from(oauthMessages)
      .where(and(eq(oauthMessages.tenantId, tenantId), eq(oauthMessages.id, id)));
    return (rows[0] as OauthMessageRow | undefined) ?? null;
  }

  // Persist a body we just pulled from the provider. We always stamp
  // body_fetched_at even when both columns are null so the reader can
  // tell "we tried, the message genuinely has no body" apart from
  // "we never asked yet".
  async setBody(
    tenantId: string,
    id: string,
    body: { text: string | null; html: string | null },
  ): Promise<void> {
    await this.db.execute(sql`
      UPDATE oauth_messages
      SET body_text = ${body.text},
          body_html = ${body.html},
          body_fetched_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${id}
    `);
  }

  async setStarred(
    tenantId: string,
    oauthAccountId: string,
    providerMessageId: string,
    starred: boolean,
  ): Promise<void> {
    await this.db.execute(sql`
      UPDATE oauth_messages
      SET starred = ${starred}
      WHERE tenant_id = ${tenantId}
        AND oauth_account_id = ${oauthAccountId}
        AND provider_message_id = ${providerMessageId}
    `);
  }

  async setUnreadByThread(
    tenantId: string,
    providerThreadId: string,
    unread: boolean,
  ): Promise<void> {
    await this.db.execute(sql`
      UPDATE oauth_messages
      SET unread = ${unread}
      WHERE tenant_id = ${tenantId}
        AND provider_thread_id = ${providerThreadId}
    `);
  }

  async setHasAttachments(
    tenantId: string,
    oauthAccountId: string,
    providerMessageId: string,
    hasAttachments: boolean,
  ): Promise<void> {
    await this.db.execute(sql`
      UPDATE oauth_messages
      SET has_attachments = ${hasAttachments}
      WHERE tenant_id = ${tenantId}
        AND oauth_account_id = ${oauthAccountId}
        AND provider_message_id = ${providerMessageId}
    `);
  }

  // List every message in the same provider thread, oldest first so
  // the reader UI can render the conversation in chronological order.
  async listByProviderThread(
    tenantId: string,
    providerThreadId: string,
  ): Promise<OauthMessageRow[]> {
    const rows = await this.db
      .select()
      .from(oauthMessages)
      .where(
        and(
          eq(oauthMessages.tenantId, tenantId),
          eq(oauthMessages.providerThreadId, providerThreadId),
        ),
      )
      .orderBy(oauthMessages.internalDate);
    return rows as OauthMessageRow[];
  }
}
