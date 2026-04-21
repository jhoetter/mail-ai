# overlay-db architecture

`@mailai/overlay-db` is the only package that opens Postgres connections. Everything that wants to persist passes through it via the command bus. Everything that wants to read uses the repositories directly (read paths are not bus-mediated).

## Goals

1. **Multi-tenant isolation by default.** Every row carries `tenant_id`; RLS is on by default in production.
2. **Idempotent ingestion.** A re-delivered IMAP fetch must NOT create duplicates; we de-dup by `(tenant_id, message_id)` (RFC 5322) and fall back to a synthetic id when missing.
3. **Repository pattern.** Application code consumes typed repositories; SQL/Drizzle stays inside the package.
4. **Audit completeness.** Every mutation lands in `audit_log` with full before/after snapshots.

## Module map

```
packages/overlay-db/src/
├── schema.ts                ← Drizzle table defs (tenants, accounts, ..., audit_log)
├── client.ts                ← pg.Pool + drizzle() factory; setTenant() helper
├── migrations.ts            ← raw SQL migrations (forward-only)
├── repos/
│   ├── accounts.ts
│   ├── messages.ts
│   ├── threads.ts
│   ├── attachments.ts
│   ├── audit.ts
│   └── pending-mutations.ts
├── threading.ts             ← consumes @mailai/mime thread() + persists
├── search.ts                ← FTS index management + query
├── attachments-store.ts     ← MinIO/S3 streaming
└── plugin.ts                ← OverlayPlugin: registers ingest + side-effect handlers
```

## Read vs write

- **Reads** are direct: a request handler in `packages/server` constructs the
  appropriate repository (already wired through DI) and calls e.g.
  `messagesRepo.listForThread(tenantId, threadId)`.
- **Writes** go through `bus.dispatch(...)`. The relevant handler is registered by `OverlayPlugin` (e.g. `imap:ingest-message`, `mail:mark-read`, `comment:add`).

## Tenant context

Every repository call accepts a `tenant_id`. The `client.setTenant(tx, id)`
helper sets `mailai.tenant_id` for the duration of a transaction so RLS works.
A handler that forgets it gets zero rows and an audit warning — we fail loud,
not silent.
