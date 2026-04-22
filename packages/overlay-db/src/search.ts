// Postgres tsvector full-text search over `messages.fts` (subject + from
// envelope as a starter — see /spec/overlay/fts.md). The `fts` column is
// maintained by a trigger created in migration 0002_fts.

import type { Database } from "./client.js";
import { sql } from "drizzle-orm";

export interface SearchHit {
  readonly id: string;
  readonly subject: string | null;
  readonly threadId: string | null;
  readonly internalDate: Date;
  readonly rank: number;
}

export interface SearchOpts {
  readonly tenantId: string;
  readonly q: string;
  readonly limit?: number;
}

export async function searchMessages(db: Database, opts: SearchOpts): Promise<SearchHit[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const q = opts.q.trim();
  if (q.length === 0) return [];
  const rows = (await db.execute(
    sql`SELECT id, subject, thread_id, internal_date,
               ts_rank_cd(fts, plainto_tsquery('simple', ${q})) AS rank
        FROM messages
        WHERE tenant_id = ${opts.tenantId}
          AND fts @@ plainto_tsquery('simple', ${q})
        ORDER BY rank DESC, internal_date DESC
        LIMIT ${limit}`,
  )) as unknown as { rows: Array<{ id: string; subject: string | null; thread_id: string | null; internal_date: Date; rank: number }> };
  return (rows.rows ?? []).map((r) => ({
    id: r.id,
    subject: r.subject,
    threadId: r.thread_id,
    internalDate: r.internal_date,
    rank: Number(r.rank),
  }));
}

export interface OauthSearchHit {
  readonly id: string;
  readonly providerThreadId: string;
  readonly subject: string | null;
  readonly snippet: string;
  readonly fromEmail: string | null;
  readonly internalDate: Date;
  readonly rank: number;
}

// Search the OAuth-message store. Distinct from `searchMessages`
// because (a) ids are 16-hex provider strings, not bigint UIDs, (b)
// there's no maintained `fts` column yet — we compute the tsvector
// inline from subject + snippet + from_email. Cheap enough for the
// current corpus (single-digit thousands of rows). Once we cross the
// "real volume" threshold, swap in a generated column + GIN index
// (one migration); the API shape stays the same.
export async function searchOauthMessages(
  db: Database,
  opts: SearchOpts,
): Promise<OauthSearchHit[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const q = opts.q.trim();
  if (q.length === 0) return [];
  const rows = (await db.execute(
    sql`SELECT id, provider_thread_id, subject, snippet, from_email, internal_date,
               ts_rank_cd(
                 to_tsvector('simple',
                   coalesce(subject,'') || ' ' ||
                   coalesce(snippet,'') || ' ' ||
                   coalesce(from_email,'')
                 ),
                 plainto_tsquery('simple', ${q})
               ) AS rank
        FROM oauth_messages
        WHERE tenant_id = ${opts.tenantId}
          AND deleted_at IS NULL
          AND to_tsvector('simple',
                coalesce(subject,'') || ' ' ||
                coalesce(snippet,'') || ' ' ||
                coalesce(from_email,'')
              ) @@ plainto_tsquery('simple', ${q})
        ORDER BY rank DESC, internal_date DESC
        LIMIT ${limit}`,
  )) as unknown as {
    rows: Array<{
      id: string;
      provider_thread_id: string;
      subject: string | null;
      snippet: string;
      from_email: string | null;
      internal_date: Date;
      rank: number;
    }>;
  };
  return (rows.rows ?? []).map((r) => ({
    id: r.id,
    providerThreadId: r.provider_thread_id,
    subject: r.subject,
    snippet: r.snippet,
    fromEmail: r.from_email,
    internalDate: r.internal_date,
    rank: Number(r.rank),
  }));
}
