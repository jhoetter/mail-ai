// Multiplexed global-search backend for the top-bar search.
//
// One entry point — `searchAll` — runs a fan-out of small per-domain
// queries against the OAuth-side stores and returns a single payload
// the front-end can split into tabs (Nachrichten / Dateien / Personen
// / Postfächer / Tags / Kalender). Mirrors the UX of
// collaboration-ai's TopBar (one HTTP round-trip, results grouped
// client-side) but is driven by mail data instead of channels.
//
// Index notes:
//   - Nachrichten uses an inline `to_tsvector('simple', ...)` that
//     covers subject, snippet, from_name, from_email and (when
//     present) body_text. This stays in source until corpus volume
//     justifies a generated column + GIN index — same trade-off the
//     pre-overhaul `searchOauthMessages` made.
//   - Dateien is `ILIKE` on `oauth_attachments.filename`. Acceptable
//     for v1 (most users have <10k attachments); upgrade path is a
//     trigram index when it stops being fast enough.
//   - Personen uses the existing pg_trgm GIN index on
//     `oauth_contacts` from migration 0016, already optimised for
//     `ILIKE '%q%'`.
//   - Tags counts come from `OauthThreadTagsRepository.countsByTag`
//     (kept as a read pattern, not duplicated here).
//
// All queries run inside the caller's `withTenant` transaction so
// row-level security applies — there is no tenant_id filter in the
// SQL on its own merit; it's there as belt-and-braces for tables
// where RLS isn't yet enforced (e.g. the legacy `tags` table).

import type { Database } from "./client.js";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------- types

export interface SearchAllOpts {
  readonly tenantId: string;
  readonly q: string;
  // Chip-derived filters parsed client-side; absent keys disable
  // the predicate. `accountId`, `tag` and the boolean flags scope
  // every domain that has a meaningful interpretation.
  readonly accountId?: string;
  readonly fromEmail?: string;
  readonly toEmail?: string;
  readonly tag?: string;
  readonly hasAttachment?: boolean;
  readonly hasLink?: boolean;
  // Per-domain caps (optional overrides). Defaults match the row
  // caps used by collab-ai's TopBar.
  readonly limits?: Partial<Record<SearchDomain, number>>;
}

export type SearchDomain =
  | "messages"
  | "files"
  | "people"
  | "mailboxes"
  | "tags"
  | "calendar";

const DEFAULT_LIMITS: Record<SearchDomain, number> = {
  messages: 20,
  files: 10,
  people: 8,
  mailboxes: 5,
  tags: 5,
  calendar: 8,
};

export interface MessageSearchHit {
  readonly threadId: string;
  readonly providerThreadId: string;
  readonly subject: string | null;
  readonly snippet: string;
  readonly fromName: string | null;
  readonly fromEmail: string | null;
  readonly date: Date;
  readonly hasAttachments: boolean;
  readonly accountId: string;
}

export interface FileSearchHit {
  readonly attachmentId: string;
  readonly filename: string | null;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly threadId: string | null;
  readonly messageId: string;
  readonly fromEmail: string | null;
  readonly date: Date | null;
}

export interface PeopleSearchHit {
  readonly contactId: string;
  readonly displayName: string | null;
  readonly primaryEmail: string;
  readonly lastInteractionAt: Date | null;
}

export interface MailboxSearchHit {
  readonly accountId: string;
  readonly email: string;
  readonly provider: string;
}

export interface TagSearchHit {
  readonly tagId: string;
  readonly name: string;
  readonly color: string;
  readonly threadCount: number;
}

export interface CalendarSearchHit {
  readonly eventId: string;
  readonly calendarId: string;
  readonly summary: string | null;
  readonly location: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

export interface SearchAllResult {
  readonly messages: MessageSearchHit[];
  readonly files: FileSearchHit[];
  readonly people: PeopleSearchHit[];
  readonly mailboxes: MailboxSearchHit[];
  readonly tags: TagSearchHit[];
  readonly calendar: CalendarSearchHit[];
}

// ---------------------------------------------------------------- impl

export async function searchAll(
  db: Database,
  opts: SearchAllOpts,
): Promise<SearchAllResult> {
  const q = opts.q.trim();
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };

  // No free-text AND no chip filter ⇒ nothing to search. Returning
  // empty arrays keeps the wire shape stable so the client doesn't
  // need a separate code path for "empty input".
  const hasAnyFilter =
    q.length > 0 ||
    Boolean(opts.accountId) ||
    Boolean(opts.fromEmail) ||
    Boolean(opts.toEmail) ||
    Boolean(opts.tag) ||
    Boolean(opts.hasAttachment) ||
    Boolean(opts.hasLink);
  if (!hasAnyFilter) {
    return {
      messages: [],
      files: [],
      people: [],
      mailboxes: [],
      tags: [],
      calendar: [],
    };
  }

  // Run the six fan-out queries in parallel — they're independent
  // and the round-trip count is what dominates latency.
  const [messages, files, people, mailboxes, tags, calendar] = await Promise.all([
    searchMessageHits(db, q, opts, limits.messages),
    searchFileHits(db, q, opts, limits.files),
    searchPeopleHits(db, q, opts, limits.people),
    searchMailboxHits(db, q, opts, limits.mailboxes),
    searchTagHits(db, q, opts, limits.tags),
    searchCalendarHits(db, q, opts, limits.calendar),
  ]);

  return { messages, files, people, mailboxes, tags, calendar };
}

// ---- Nachrichten -------------------------------------------------------

async function searchMessageHits(
  db: Database,
  q: string,
  opts: SearchAllOpts,
  limit: number,
): Promise<MessageSearchHit[]> {
  // We compute the tsvector inline (subject + snippet + from_name +
  // from_email + body_text). When `q` is empty but a chip filter is
  // present we skip the FTS match entirely so e.g. `tag:urgent`
  // alone still returns the latest tagged threads.
  const tsv = sql`to_tsvector('simple',
        coalesce(m.subject,'') || ' ' ||
        coalesce(m.snippet,'') || ' ' ||
        coalesce(m.from_name,'') || ' ' ||
        coalesce(m.from_email,'') || ' ' ||
        coalesce(m.body_text,''))`;

  const where: ReturnType<typeof sql>[] = [sql`m.deleted_at IS NULL`];
  if (q.length > 0) {
    where.push(sql`${tsv} @@ plainto_tsquery('simple', ${q})`);
  }
  if (opts.accountId) {
    where.push(sql`m.oauth_account_id = ${opts.accountId}`);
  }
  if (opts.fromEmail) {
    where.push(sql`m.from_email ILIKE ${"%" + opts.fromEmail + "%"}`);
  }
  if (opts.toEmail) {
    where.push(sql`m.to_addr ILIKE ${"%" + opts.toEmail + "%"}`);
  }
  if (opts.hasAttachment) {
    where.push(sql`m.has_attachments = true`);
  }
  if (opts.hasLink) {
    where.push(sql`(m.body_text ILIKE '%http://%' OR m.body_text ILIKE '%https://%')`);
  }
  if (opts.tag) {
    // EXISTS subquery against the OAuth tag bridge. The join target
    // is the tag *name* (chips carry the human-readable label) so
    // we resolve `tags.id` here rather than forcing the client to.
    where.push(sql`EXISTS (
      SELECT 1 FROM oauth_thread_tags ott
      INNER JOIN tags t ON t.id = ott.tag_id
      WHERE ott.tenant_id = ${opts.tenantId}
        AND ott.provider_thread_id = m.provider_thread_id
        AND lower(t.name) = lower(${opts.tag})
    )`);
  }

  const whereSql = where.reduce((acc, predicate, idx) =>
    idx === 0 ? predicate : sql`${acc} AND ${predicate}`,
  );

  // Ordering: rank-first when we have FTS, date-first otherwise.
  // Either way, secondary sort by internal_date keeps tied rows in
  // a stable, recency-friendly order.
  const orderSql =
    q.length > 0
      ? sql`ts_rank_cd(${tsv}, plainto_tsquery('simple', ${q})) DESC, m.internal_date DESC`
      : sql`m.internal_date DESC`;

  const rows = (await db.execute(sql`
    SELECT m.id, m.provider_thread_id, m.subject, m.snippet,
           m.from_name, m.from_email, m.internal_date,
           m.has_attachments, m.oauth_account_id
    FROM oauth_messages m
    WHERE ${whereSql}
    ORDER BY ${orderSql}
    LIMIT ${limit}
  `)) as unknown as {
    rows: Array<{
      id: string;
      provider_thread_id: string;
      subject: string | null;
      snippet: string;
      from_name: string | null;
      from_email: string | null;
      internal_date: Date;
      has_attachments: boolean;
      oauth_account_id: string;
    }>;
  };
  return (rows.rows ?? []).map((r) => ({
    threadId: r.id,
    providerThreadId: r.provider_thread_id,
    subject: r.subject,
    snippet: r.snippet,
    fromName: r.from_name,
    fromEmail: r.from_email,
    date: r.internal_date,
    hasAttachments: r.has_attachments,
    accountId: r.oauth_account_id,
  }));
}

// ---- Dateien -----------------------------------------------------------

async function searchFileHits(
  db: Database,
  q: string,
  opts: SearchAllOpts,
  limit: number,
): Promise<FileSearchHit[]> {
  // Inline attachments aren't user-visible files; the dropdown only
  // ever wants real attachments. We join `oauth_messages` to surface
  // sender + thread + date in the row.
  const where: ReturnType<typeof sql>[] = [sql`a.is_inline = false`];
  if (q.length > 0) {
    where.push(sql`a.filename ILIKE ${"%" + q + "%"}`);
  }
  if (opts.accountId) {
    where.push(sql`a.oauth_account_id = ${opts.accountId}`);
  }
  if (opts.fromEmail) {
    where.push(sql`m.from_email ILIKE ${"%" + opts.fromEmail + "%"}`);
  }

  const whereSql = where.reduce((acc, predicate, idx) =>
    idx === 0 ? predicate : sql`${acc} AND ${predicate}`,
  );

  const rows = (await db.execute(sql`
    SELECT a.id, a.filename, a.mime, a.size_bytes, a.provider_message_id,
           m.id AS message_id, m.provider_thread_id, m.from_email, m.internal_date
    FROM oauth_attachments a
    LEFT JOIN oauth_messages m
      ON m.oauth_account_id = a.oauth_account_id
      AND m.provider_message_id = a.provider_message_id
    WHERE ${whereSql}
    ORDER BY m.internal_date DESC NULLS LAST
    LIMIT ${limit}
  `)) as unknown as {
    rows: Array<{
      id: string;
      filename: string | null;
      mime: string;
      size_bytes: string | number;
      message_id: string | null;
      provider_thread_id: string | null;
      from_email: string | null;
      internal_date: Date | null;
    }>;
  };
  return (rows.rows ?? []).map((r) => ({
    attachmentId: r.id,
    filename: r.filename,
    mime: r.mime,
    sizeBytes: typeof r.size_bytes === "string" ? Number(r.size_bytes) : r.size_bytes,
    threadId: r.provider_thread_id,
    messageId: r.message_id ?? "",
    fromEmail: r.from_email,
    date: r.internal_date,
  }));
}

// ---- Personen ----------------------------------------------------------

async function searchPeopleHits(
  db: Database,
  q: string,
  opts: SearchAllOpts,
  limit: number,
): Promise<PeopleSearchHit[]> {
  // Personen has no useful read on chip filters other than the
  // free-text query — `from:` / `to:` describe messages, not the
  // person themselves. We still apply `accountId` so a scoped
  // search ("everything in this mailbox") narrows the address book.
  const where: ReturnType<typeof sql>[] = [];
  if (q.length > 0) {
    where.push(
      sql`(c.display_name ILIKE ${"%" + q + "%"} OR c.primary_email ILIKE ${"%" + q + "%"})`,
    );
  }
  if (opts.accountId) {
    where.push(sql`c.oauth_account_id = ${opts.accountId}`);
  }
  if (where.length === 0) {
    return [];
  }
  const whereSql = where.reduce((acc, predicate, idx) =>
    idx === 0 ? predicate : sql`${acc} AND ${predicate}`,
  );

  const rows = (await db.execute(sql`
    SELECT c.id, c.display_name, c.primary_email, c.last_interaction_at
    FROM oauth_contacts c
    WHERE ${whereSql}
    ORDER BY c.last_interaction_at DESC NULLS LAST
    LIMIT ${limit}
  `)) as unknown as {
    rows: Array<{
      id: string;
      display_name: string | null;
      primary_email: string;
      last_interaction_at: Date | null;
    }>;
  };
  return (rows.rows ?? []).map((r) => ({
    contactId: r.id,
    displayName: r.display_name,
    primaryEmail: r.primary_email,
    lastInteractionAt: r.last_interaction_at,
  }));
}

// ---- Postfächer --------------------------------------------------------

async function searchMailboxHits(
  db: Database,
  q: string,
  opts: SearchAllOpts,
  limit: number,
): Promise<MailboxSearchHit[]> {
  // Mailbox results are the connected OAuth accounts. Free-text
  // matches the email address; otherwise (chip-only search) we
  // surface every account so the user sees what's available.
  const where: ReturnType<typeof sql>[] = [];
  if (q.length > 0) {
    where.push(sql`(a.email ILIKE ${"%" + q + "%"})`);
  }
  if (opts.accountId) {
    where.push(sql`a.id = ${opts.accountId}`);
  }
  const whereSql =
    where.length === 0
      ? sql`true`
      : where.reduce((acc, predicate, idx) =>
          idx === 0 ? predicate : sql`${acc} AND ${predicate}`,
        );

  const rows = (await db.execute(sql`
    SELECT a.id, a.email, a.provider
    FROM oauth_accounts a
    WHERE ${whereSql}
    ORDER BY a.email ASC
    LIMIT ${limit}
  `)) as unknown as {
    rows: Array<{ id: string; email: string; provider: string }>;
  };
  return (rows.rows ?? []).map((r) => ({
    accountId: r.id,
    email: r.email,
    provider: r.provider,
  }));
}

// ---- Tags --------------------------------------------------------------

async function searchTagHits(
  db: Database,
  q: string,
  opts: SearchAllOpts,
  limit: number,
): Promise<TagSearchHit[]> {
  const where: ReturnType<typeof sql>[] = [sql`t.tenant_id = ${opts.tenantId}`];
  if (q.length > 0) {
    where.push(sql`t.name ILIKE ${"%" + q + "%"}`);
  }
  if (opts.tag) {
    where.push(sql`lower(t.name) = lower(${opts.tag})`);
  }
  const whereSql = where.reduce((acc, predicate, idx) =>
    idx === 0 ? predicate : sql`${acc} AND ${predicate}`,
  );

  const rows = (await db.execute(sql`
    SELECT t.id, t.name, t.color,
           coalesce((
             SELECT count(*)::int FROM oauth_thread_tags ott
             WHERE ott.tenant_id = t.tenant_id AND ott.tag_id = t.id
           ), 0) AS thread_count
    FROM tags t
    WHERE ${whereSql}
    ORDER BY thread_count DESC, t.name ASC
    LIMIT ${limit}
  `)) as unknown as {
    rows: Array<{ id: string; name: string; color: string; thread_count: number }>;
  };
  return (rows.rows ?? []).map((r) => ({
    tagId: r.id,
    name: r.name,
    color: r.color,
    threadCount: Number(r.thread_count),
  }));
}

// ---- Kalender ----------------------------------------------------------

async function searchCalendarHits(
  db: Database,
  q: string,
  opts: SearchAllOpts,
  limit: number,
): Promise<CalendarSearchHit[]> {
  const where: ReturnType<typeof sql>[] = [];
  if (q.length > 0) {
    where.push(sql`(
      e.summary ILIKE ${"%" + q + "%"} OR
      e.description ILIKE ${"%" + q + "%"} OR
      e.location ILIKE ${"%" + q + "%"}
    )`);
  }
  if (opts.accountId) {
    where.push(sql`c.oauth_account_id = ${opts.accountId}`);
  }
  if (where.length === 0) {
    return [];
  }
  const whereSql = where.reduce((acc, predicate, idx) =>
    idx === 0 ? predicate : sql`${acc} AND ${predicate}`,
  );

  // Order by proximity-to-now: future events first (closest first),
  // then past events (most recent first). Implemented as `abs(diff)`
  // with a tie-breaker on starts_at descending so it's deterministic.
  const rows = (await db.execute(sql`
    SELECT e.id, e.calendar_id, e.summary, e.location, e.starts_at, e.ends_at
    FROM events e
    INNER JOIN calendars c ON c.id = e.calendar_id
    WHERE ${whereSql}
    ORDER BY abs(extract(epoch FROM (e.starts_at - now()))) ASC,
             e.starts_at DESC
    LIMIT ${limit}
  `)) as unknown as {
    rows: Array<{
      id: string;
      calendar_id: string;
      summary: string | null;
      location: string | null;
      starts_at: Date;
      ends_at: Date;
    }>;
  };
  return (rows.rows ?? []).map((r) => ({
    eventId: r.id,
    calendarId: r.calendar_id,
    summary: r.summary,
    location: r.location,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
  }));
}
