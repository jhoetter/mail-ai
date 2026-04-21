# Audit log

## Schema

`audit_log` (see `spec/overlay/schema.md`) — one row per mutation, including failed and rejected ones.

## Invariants

1. **Every mutation, no exceptions.** The CommandBus emits to its audit sink for `applied`, `failed`, `pending`, `rejected`. `OverlayPlugin` writes the row.
2. **Append-only at app layer.** No `UPDATE` or `DELETE` from any handler. Retention job runs nightly with a separate role.
3. **Full snapshots.** `before` and `after` are stored as full entity JSON; downstream tooling can reconstruct any historical state by replaying `audit_log`.
4. **Replay-safe.** Replaying a sequence of mutations against a fresh DB reproduces the final state byte-for-byte (modulo IDs/timestamps for synthesized fields). Verified by Phase 3 Validate's "audit completeness" test.

## Indexes

- `(mutation_id)` UNIQUE — guard against double-write.
- `(tenant_id, created_at)` — list-by-time per tenant for the UI's activity feed.
- `(tenant_id, command_type)` — analytics queries.

## Retention

Default: 365 days for `applied/failed/rejected`, 90 days for `pending` (auto-expired). Per-tenant override via `tenants.config.audit_retention_days`.

## Compliance export

`mail-agent audit export --tenant t_acme --since 2026-01-01 --until 2026-04-01 --format jsonl > audit.jsonl` — produces one line per mutation in chronological order.
