# Phase 3 — Collaboration build log

## What shipped

- **`@mailai/overlay-db` v3 schema/migration**
  - New tables `inboxes`, `inbox_mailboxes`, `inbox_members` with RLS
    policies (`tenant_iso`).
  - Plain-SQL migration `0004_inboxes` (no `drizzle-kit`, per
    `spec/overlay/schema.md`).
  - `InboxesRepository` with the narrow read/write surface required by
    the collaboration plugin and HTTP layer.
- **`OverlayPlugin` scope reduced**
  - Now only registers IMAP-side commands (`mail:mark-read`,
    `mail:mark-unread`). Domain commands live solely in
    `CollaborationPlugin`, eliminating duplicate-handler conflicts on a
    shared `CommandBus`.
- **`@mailai/collaboration` plugin completion**
  - `addComment` persists via `CommentsRepository` when one is wired,
    and uses `node:crypto.randomUUID` (no implicit globals).
  - `RBAC` now exposes `InboxRole` + `canInInbox` / `assertCanInInbox`
    so per-inbox membership intersects with tenant role. Backed by a
    capability table mirroring `spec/collaboration/rbac.md`.
  - `runSlaTick` worker emits `sla:overdue` events and re-opens
    snoozed threads via the bus (so audit shows a normal
    `thread:set-status` mutation by `system:sla-worker`).
- **Tests**
  - `sla-worker.test.ts` covers happy-path overdue detection and
    snooze auto-reopen.
  - `rbac.test.ts` covers the tenant∩inbox intersection, including
    missing inbox membership.
- **Architecture invariants**
  - `node scripts/check-architecture.mjs` → `architecture: ok` after
    these additions; no new forbidden imports were introduced.

## Why this scope

The Phase-3 spec set the contract; the build keeps the implementation
side narrow:

- **Single ownership of mutations**: only `CollaborationPlugin` mutates
  collaboration state. `OverlayPlugin` is restricted to IMAP-side
  effects.
- **Two-layer RBAC**: the spec calls out a deliberate separation
  between "tenant role" (can the user touch the product) and "inbox
  role" (what can they do inside this inbox). The implementation now
  matches.
- **SLA as audited mutation**: re-opening a snoozed thread is a
  first-class `thread:set-status` command (not a side-table flip), so
  the audit log stays the single source of truth.

## Validate

Three new integration suites under `tests/integration/src/`:

- `audit-completeness.test.ts` — every successful collaboration
  mutation reaches the audit sink with `before/after/diffs`; failed
  handlers still emit `status=failed` audit entries.
- `permission-boundaries.test.ts` — RBAC denials at the boundary,
  including the tenant∩inbox intersection and the missing-membership
  case.
- `multi-user-scenario.test.ts` — full intake → assign → comment →
  resolve flow across two humans + one agent, asserting both audit
  ordering and `@mention` extraction.

Overlay isolation re-check is covered by the existing
`overlay-isolation.test.ts` snapshot diff (no overlay-db change in
Phase 3 touched the IMAP-side path).

