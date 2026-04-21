# Phase 2 — overlay-db, threading, FTS, attachments

## What shipped

- **`@mailai/overlay-db`**:
  - Drizzle schema (`schema.ts`) for tenants, users, accounts, mailboxes, messages, threads, tags, thread_tags, comments, attachments_meta, audit_log, pending_mutations, sync_state.
  - Plain-SQL migrations in `migrations.ts`: `0001_init` (DDL), `0002_fts` (tsvector trigger + GIN index), `0003_rls` (RLS policies on every multi-tenant table).
  - `client.ts` exposes `createPool`, `createDb`, and `withTenant(pool, tenantId, fn)` for RLS-bound transactions.
  - Repositories: `accounts`, `messages`, `threads`, `comments`, `tags`, `attachments`, `pending-mutations`, `audit`.
  - `threading.ts` persists JWZ threading via `assignThread`, including merge of converging threads.
  - `search.ts` exposes `searchMessages(db, { tenantId, q, limit })` against `messages.fts`.
  - `attachments-store.ts` defines an `ObjectStore` interface and an `InMemoryObjectStore` for tests; the production wiring uses MinIO/S3 with the same key layout (see `objectKeys`).
  - `dedup.ts` provides `syntheticMessageId` for messages without a usable `Message-ID`.
  - `plugin.ts` exposes `OverlayPlugin` that registers `thread:set-status`, `thread:assign`, `comment:add`, `mail:mark-read` against a `CommandBus`.

## Specs delivered alongside

- `spec/overlay/architecture.md`
- `spec/overlay/schema.md`
- `spec/overlay/threading.md`
- `spec/overlay/fts.md`
- `spec/overlay/multi-tenancy.md`
- `spec/overlay/attachments.md`

## What is intentionally not yet wired

- Streaming attachment HTTP routes — Phase 3 / Phase 5.
- The outboxer-result feedback loop (overlay flag bookkeeping after IMAP STORE succeeds) — Phase 3.
- Body-text excerpt generation on ingest — currently the FTS index uses subject + first `from` only; full-body indexing is a Phase 3 follow-up.
