# overlay-db — schema

Authoritative reference for the Postgres schema. Source of truth is [`packages/overlay-db/src/schema.ts`](../../packages/overlay-db/src/schema.ts) (Drizzle). When the two disagree, fix Drizzle and re-run migrations.

## Tables (v1)

### `tenants`

- `id` text PK
- `name` text NOT NULL
- `created_at` timestamptz default now()

### `users`

- `id` text PK
- `tenant_id` text REFERENCES tenants(id)
- `email` text NOT NULL
- `display_name` text
- `role` text CHECK (role IN ('admin','member','read-only'))
- `created_at` timestamptz default now()

### `accounts`

- `id` text PK
- `tenant_id`, `user_id`
- `provider` text CHECK (provider IN ('gmail','microsoft','imap'))
- `display_email` text NOT NULL
- `imap_host`, `imap_port`, `imap_secure`
- `smtp_host`, `smtp_port`, `smtp_secure`
- `credential_blob` bytea (AES-GCM encrypted)
- `status` text CHECK (status IN ('connected','needs-reauth','disabled'))
- `last_sync_at` timestamptz
- `created_at` timestamptz default now()

### `mailboxes`

- `id` text PK
- `tenant_id`, `account_id`
- `path` text NOT NULL
- `delimiter` text NOT NULL DEFAULT '/'
- `special_use` text NULL
- `subscribed` boolean DEFAULT true
- `uid_validity` bigint NOT NULL
- `highest_mod_seq` numeric NULL
- `last_synced_uid` bigint NOT NULL DEFAULT 0
- `last_synced_at` timestamptz NULL
- UNIQUE (account_id, path)

### `messages`

- `id` text PK (UUIDv7)
- `tenant_id`, `account_id`, `mailbox_id`
- `uid` bigint NOT NULL
- `mod_seq` numeric NULL
- `internal_date` timestamptz NOT NULL
- `size` bigint NOT NULL
- `flags_json` jsonb NOT NULL DEFAULT '[]'
- `message_id` text NOT NULL
- `subject` text
- `date` timestamptz
- `from_json` jsonb NOT NULL DEFAULT '[]'
- `to_json` jsonb NOT NULL DEFAULT '[]'
- `cc_json`, `bcc_json` jsonb DEFAULT '[]'
- `in_reply_to_json` jsonb DEFAULT '[]'
- `references_json` jsonb DEFAULT '[]'
- `text_excerpt` text
- `body_text_ref` text NULL -- S3 ref
- `body_html_ref` text NULL -- S3 ref
- `body_raw_ref` text NULL -- S3 ref to raw RFC 822 (for replay)
- `body_skipped` boolean DEFAULT false
- `thread_id` text REFERENCES threads(id) NULL
- `tsv` tsvector NOT NULL -- maintained by trigger
- `created_at` timestamptz DEFAULT now()
- UNIQUE (mailbox_id, uid)
- INDEX (tenant_id, message_id)

### `threads`

- `id` text PK
- `tenant_id`
- `subject_norm` text NOT NULL
- `participants_json` jsonb NOT NULL DEFAULT '[]'
- `first_message_at`, `last_message_at` timestamptz
- `message_count` integer DEFAULT 0
- `status` text CHECK (status IN ('open','snoozed','resolved')) DEFAULT 'open'
- `assigned_user_id` text NULL
- `created_at` timestamptz DEFAULT now()

### `tags`

- `id` text PK
- `tenant_id`, `name` text, `color` text
- UNIQUE (tenant_id, name)

### `thread_tags`

- `tenant_id`, `thread_id`, `tag_id`
- PRIMARY KEY (thread_id, tag_id)

### `comments`

- `id` text PK
- `tenant_id`, `thread_id`, `author_user_id`
- `body_md` text NOT NULL
- `mentions_json` jsonb DEFAULT '[]'
- `created_at` timestamptz DEFAULT now()
- `edited_at` timestamptz NULL
- `deleted_at` timestamptz NULL

### `attachments`

- `id` text PK
- `tenant_id`, `message_id`
- `filename` text, `content_type` text
- `size` bigint, `disposition` text, `content_id` text
- `checksum` text
- `storage_ref` text NOT NULL -- S3 key

### `audit_log` (append-only)

- `id` text PK
- `tenant_id`
- `actor_id` text
- `actor_kind` text CHECK (actor_kind IN ('human','agent','system'))
- `command_type` text NOT NULL
- `command_payload` jsonb NOT NULL
- `before` jsonb NOT NULL
- `after` jsonb NOT NULL
- `diffs` jsonb NOT NULL
- `imap_side_effects` jsonb NOT NULL
- `status` text NOT NULL
- `error_code` text NULL
- `error_message` text NULL
- `created_at` timestamptz DEFAULT now()
- INDEX (tenant_id, created_at DESC)

### `pending_mutations`

- `id` text PK
- `tenant_id`, `actor_id`
- `command_type` text NOT NULL
- `command_payload` jsonb NOT NULL
- `proposed_diffs` jsonb NOT NULL
- `status` text CHECK (status IN ('pending','approved','rejected','expired'))
- `created_at`, `expires_at`, `decided_at` timestamptz
- `decided_by` text NULL

### Sessions / RBAC tables (Phase 3)

`memberships`, `inboxes`, `inbox_members` are added in Phase 3 alongside the collaboration plugin's needs.

## RLS policies

```sql
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON accounts
  USING (tenant_id = current_setting('mailai.tenant_id', true));
-- repeat for: mailboxes, messages, threads, tags, thread_tags,
-- comments, attachments, audit_log, pending_mutations, memberships,
-- inboxes, inbox_members.
```

## Migrations strategy

Forward-only, plain SQL stored in `packages/overlay-db/migrations/NNNN_*.sql`. The `migrations.ts` runner reads these in order, records each in a `__migrations__` table, and runs untranslated SQL inside a single transaction per file.

We deliberately don't use `drizzle-kit` to autogenerate migrations — Drizzle is the read/typed-write surface, not the schema authority for v1, because we have non-Drizzle-expressible features (RLS policies, tsvector triggers, generated columns).
