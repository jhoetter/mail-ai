# Collaboration features (Phase 3)

> Per `prompt.md` §Quality Bar — "Coordinate work the way Front, Hiver, and Missive coordinate work, with overlay-only metadata."

## Shared inboxes

A shared inbox is a logical view over one or more `mailbox`es belonging to one or more `account`s, restricted to a set of users. Two real-world examples:

1. `support@acme.com` IMAP account → INBOX → "Support" inbox visible to support team.
2. Each agent's personal `me@acme.com` Gmail INBOX → "All sales" inbox visible to AEs.

Schema additions in Phase 3 build:

```sql
CREATE TABLE inboxes (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  name text NOT NULL,
  description text,
  config jsonb NOT NULL DEFAULT '{}'  -- { auto_assign: 'round-robin' | 'manual', sla_hours: 4, ... }
);
CREATE TABLE inbox_mailboxes (
  inbox_id text NOT NULL REFERENCES inboxes(id),
  account_id text NOT NULL REFERENCES accounts(id),
  mailbox_path text NOT NULL,
  PRIMARY KEY (inbox_id, account_id, mailbox_path)
);
CREATE TABLE inbox_members (
  inbox_id text NOT NULL REFERENCES inboxes(id),
  user_id  text NOT NULL REFERENCES users(id),
  role     text NOT NULL CHECK (role IN ('inbox-admin','agent','viewer')),
  PRIMARY KEY (inbox_id, user_id)
);
```

## Assignment

A thread can be assigned to exactly one user at a time. History is preserved in `audit_log` (every `thread:assign` mutation is a row). Two flavours:

- **Manual**: user clicks "assign to me / X".
- **Round-robin**: when a new thread arrives in an inbox with `auto_assign='round-robin'`, the OverlayPlugin emits `thread:assign` with a system actor.

## Status workflow

Status FSM lives in the collaboration package:

```
   open ──▶ snoozed ──▶ open
    │
    └──▶ resolved ──▶ open
```

Allowed transitions only — illegal transitions throw `MailaiError("conflict_error")` from the handler. Snoozing requires a `snoozed_until` timestamp; the worker un-snoozes (re-emits `thread:set-status open`) at that time.

## Tags

User-defined labels. Distinct from Gmail labels (which we treat as mailboxes). Many-to-many to threads. Color codes are `#RRGGBB`.

## Comments + mentions

Markdown body. `@username` mentions are extracted with the regex `/(?:^|\s)@([a-zA-Z0-9._-]+)/g`, matched against `users.email`'s local-part. Mention list is denormalised onto `comments.mentions_json` for fast notification fan-out.

## SLA timers

Per-inbox `sla_hours`. A worker scans every inbox hourly, finds threads in `status='open'` with `last_message_at + sla_hours < now()`, and emits a `thread:sla-breached` event broadcast on the realtime channel. No mutation is created (we don't change state automatically); we surface a UI badge.

## Audit log

Every Mutation lands in `audit_log` via `OverlayPlugin`'s mutation observer.
The collaboration plugin adds derived rows for "thread reopened", "thread reassigned" so the UI's history view doesn't have to interpret `thread:set-status` differently from `thread:assign`.

The audit log is **append-only** at the application level. Database `DELETE FROM audit_log` is permitted only by a dedicated retention job that respects per-tenant retention windows; the application role used by handlers does NOT have DELETE on this table.
