# overlay-db — multi-tenancy isolation

## Strategy: shared schema + RLS

A single Postgres database; every row carries `tenant_id`; PostgreSQL Row-Level Security enforces isolation. The schema-per-tenant alternative (one schema, many tables × N tenants) was rejected because:

- migrations would have to be applied N times,
- shared search/threading code would need to dynamically pick a schema name,
- backups/restores per-tenant become awkward.

## Per-request mechanics

```ts
await client.query("BEGIN");
await client.query("SET LOCAL mailai.tenant_id = $1", [tenantId]);
// every following SELECT/INSERT/UPDATE filtered by RLS
await client.query("COMMIT");
```

The `withTenant()` helper in `packages/overlay-db/src/client.ts` wraps this,
so application code looks like:

```ts
await db.withTenant(tenantId, async (tx) => {
  return messagesRepo.list(tx, ...);
});
```

A handler that calls `withTenant` with the wrong id, or skips it, gets zero
rows or a permission error from RLS — no silent cross-tenant read.

## Validation

Phase 2 Validate adds an integration test:

1. Bootstrap two tenants `t1`, `t2`.
2. Insert known data into each via `withTenant`.
3. Try to read `t1`'s rows from a `withTenant(t2)` context.
4. Assert zero rows.
5. Try to bypass the helper (`SELECT *` outside any `withTenant`) and assert RLS denies the query (when SET ROLE to a non-superuser application role).

## Data lifecycle

- Tenant deletion is a separate RPC; it cascades through every table and removes attachment objects from S3 in a background job.
- Backups are tenant-aware via `pg_dump --include-foreign-data` filtered by `tenant_id` (we use logical dumps, not physical).
