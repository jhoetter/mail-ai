# overlay-db — full text search

## Index column

`messages.tsv tsvector NOT NULL`, maintained by trigger:

```sql
CREATE OR REPLACE FUNCTION messages_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW.tsv :=
    setweight(to_tsvector('simple', coalesce(NEW.subject, '')), 'A') ||
    setweight(to_tsvector('simple',
      coalesce(NEW.from_json::text, '') || ' ' ||
      coalesce(NEW.to_json::text, '')
    ), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.text_excerpt, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER messages_tsv_trigger
  BEFORE INSERT OR UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_tsv_update();

CREATE INDEX messages_tsv_gin ON messages USING gin (tsv);
CREATE INDEX messages_tenant_tsv ON messages USING gin (tenant_id, tsv);
```

`text_excerpt` is the first 4 KB of the parsed plain-text body, truncated on a word boundary, stored unaccented and lowercased. Full bodies are NOT in tsv (cost-prohibitive at scale; users hit the body via per-message fetch from S3).

## Query API

```ts
searchRepo.search(tenantId, {
  q: "invoice 4517",
  inboxId?: string,
  status?: "open"|"resolved"|"snoozed",
  from?: Date,
  to?: Date,
  limit: number,
  cursor?: string,
}): Promise<SearchResult>
```

Internally:

```sql
SELECT id, subject, ts_rank_cd(tsv, q) AS rank, ...
FROM messages, plainto_tsquery('simple', :q) q
WHERE tenant_id = :tenant
  AND tsv @@ q
  AND (:inbox IS NULL OR mailbox_id IN (...))
  AND (...filters...)
ORDER BY rank DESC, internal_date DESC
LIMIT :limit;
```

## Why `simple` and not English?

Multi-language mailboxes are the norm. `simple` (no stemming, no stop words) gives predictable behaviour across locales and avoids "search for 'wins' returns 'won'" surprises that confuse users. We surface a Phase-3 toggle for per-tenant English/German/etc. dictionaries.

## What about Meilisearch / Tantivy / Elasticsearch?

Out of scope for v1. Postgres FTS is fast enough for shared inboxes (≤10M
messages per tenant) and avoids the operational cost of a second store. The
seam is `searchRepo`; swapping the implementation later doesn't touch the
command bus.
