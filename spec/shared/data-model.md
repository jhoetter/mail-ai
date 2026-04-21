# Data model (shared)

This is the canonical entity dictionary. Every package refers to these
shapes; the Drizzle schema in [`packages/overlay-db/src/schema.ts`](../../packages/overlay-db/src/schema.ts) is the runtime enforcement.

## Core entities

### Tenant
Logical isolation boundary. Every other row carries `tenant_id`. RLS policies (see [`security-model.md`](security-model.md#row-level-security)) ensure a tenant can never read another tenant's data even when the application layer mis-routes a query.

### User
A human in our system. Has a `role` from `{admin, member, read-only}` (see [`packages/collaboration/src/rbac.ts`](../../packages/collaboration/src/rbac.ts)). Email here is **our identity** for the user, not necessarily their connected mailbox.

### Account
A connected mailbox (Gmail, Microsoft, generic IMAP). One `User` may own many `Account`s. `credential_blob` is encrypted-at-rest with a per-tenant data-encryption key (DEK), wrapped by a KMS-managed master.

### Mailbox
An IMAP folder (`INBOX`, `[Gmail]/All Mail`, etc.) belonging to one Account. Tracks `uid_validity` and `highest_mod_seq` for delta sync.

### Message
An email. The `(mailbox_id, uid)` pair is unique per IMAP semantics; `message_id` (RFC 5322 `Message-ID`) is the cross-folder identity used for deduping (Phase 2 algorithm).

### Thread
A JWZ-threaded group of messages. Threads are overlay-only — IMAP has no concept of threads. The same RFC 822 message in two folders ends up in one Thread because dedup runs *before* threading.

### Tag, ThreadTag
Overlay-only labels. Distinct from Gmail labels (which we treat as mailboxes for sync).

### Comment
Internal-only message attached to a Thread. Mentions are extracted at write time and stored in `mentions_json` for fast notification fan-out.

### Attachment metadata
Attachment payloads live in MinIO/S3 (`storage_ref`); metadata stays in Postgres so search & list operations don't need object-store roundtrips.

### Audit log
Append-only record of every Mutation that flowed through the bus. Every command creates exactly one audit row, including failed commands. This is the single source of truth for "what happened in mail-ai" and is exported on demand for compliance.

### Pending mutations
Staged agent mutations awaiting human approval (see [`packages/core/src/command/policy.ts`](../../packages/core/src/command/policy.ts)). Stored separately from `audit_log` so the projection layer (UI showing "draft" state) can join cheaply.

## Field-level conventions

- All IDs are opaque text (UUIDv7-style preferred for sortability).
- All timestamps are `timestamptz`.
- All "addresses" payloads are JSON arrays of `{ name, address }`.
- All flags are JSON arrays preserving IMAP casing (`\\Seen`, `\\Answered`, `$Forwarded`).
- All `*_ref` columns are S3 keys; format `t/{tenant}/m/{message_id}/raw.eml` etc.

## Out of scope (not modelled in v1)

- Per-message ACLs (RBAC is per-inbox in v1).
- Drafts on the server (composer state lives in the browser; only "Send" creates a Message).
- Read receipts.
- Calendar invites (parsed but not interpreted).
