// Plain-SQL migrations. We deliberately avoid drizzle-kit codegen here
// so the migrations are fully reviewable in PRs and the dev/CI/prod
// stack do not need an extra generator step. drizzle's runtime types
// are still derived from src/schema.ts.

import type { Pool } from "pg";

export const MIGRATIONS: Array<{ id: string; up: string }> = [
  {
    id: "0001_init",
    up: `
      CREATE TABLE IF NOT EXISTS tenants (
        id text PRIMARY KEY,
        name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS users (
        id text PRIMARY KEY,
        tenant_id text NOT NULL REFERENCES tenants(id),
        email text NOT NULL,
        display_name text NOT NULL,
        role text NOT NULL CHECK (role IN ('admin','member','read-only')),
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS accounts (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        user_id text NOT NULL REFERENCES users(id),
        provider text NOT NULL,
        address text NOT NULL,
        imap_host text NOT NULL,
        imap_port integer NOT NULL,
        smtp_host text NOT NULL,
        smtp_port integer NOT NULL,
        credential_blob text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS accounts_tenant_addr_idx ON accounts(tenant_id, address);

      CREATE TABLE IF NOT EXISTS mailboxes (
        id text PRIMARY KEY,
        account_id text NOT NULL REFERENCES accounts(id),
        tenant_id text NOT NULL,
        path text NOT NULL,
        delimiter text NOT NULL,
        special_use text,
        is_shared boolean NOT NULL DEFAULT false,
        uid_validity bigint NOT NULL,
        highest_mod_seq bigint,
        last_synced_uid integer NOT NULL DEFAULT 0,
        last_fetch_at timestamptz
      );

      CREATE TABLE IF NOT EXISTS messages (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        account_id text NOT NULL REFERENCES accounts(id),
        mailbox_id text NOT NULL REFERENCES mailboxes(id),
        uid integer NOT NULL,
        message_id text,
        thread_id text,
        subject text,
        from_json jsonb NOT NULL,
        to_json jsonb NOT NULL,
        cc_json jsonb,
        in_reply_to text,
        references_json jsonb,
        flags_json jsonb NOT NULL,
        size_bytes integer NOT NULL,
        internal_date timestamptz NOT NULL,
        body_text_ref text,
        body_html_ref text,
        raw_ref text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS messages_mailbox_uid_idx ON messages(mailbox_id, uid);
      CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages(tenant_id, thread_id);
      CREATE INDEX IF NOT EXISTS messages_msgid_idx ON messages(tenant_id, message_id);

      CREATE TABLE IF NOT EXISTS threads (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        account_id text NOT NULL REFERENCES accounts(id),
        root_message_id text,
        subject text,
        status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','snoozed','resolved','archived')),
        snoozed_until timestamptz,
        assigned_to text REFERENCES users(id),
        last_message_at timestamptz NOT NULL
      );
      CREATE INDEX IF NOT EXISTS threads_tenant_status_idx ON threads(tenant_id, status);

      CREATE TABLE IF NOT EXISTS attachments_meta (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        message_id text NOT NULL REFERENCES messages(id),
        filename text,
        content_type text NOT NULL,
        size_bytes integer NOT NULL,
        storage_ref text NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tags (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        name text NOT NULL,
        color text NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_tags (
        thread_id text NOT NULL REFERENCES threads(id),
        tag_id text NOT NULL REFERENCES tags(id),
        tenant_id text NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS thread_tags_pk ON thread_tags(thread_id, tag_id);

      CREATE TABLE IF NOT EXISTS comments (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        thread_id text NOT NULL REFERENCES threads(id),
        author_id text NOT NULL REFERENCES users(id),
        body text NOT NULL,
        mentions_json jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        edited_at timestamptz,
        deleted_at timestamptz
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        seq bigserial PRIMARY KEY,
        tenant_id text NOT NULL,
        mutation_id text NOT NULL,
        command_type text NOT NULL,
        actor_id text NOT NULL,
        source text NOT NULL,
        payload_json jsonb NOT NULL,
        diff_json jsonb,
        status text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS audit_log_mut_idx ON audit_log(mutation_id);
      CREATE INDEX IF NOT EXISTS audit_log_tenant_time_idx ON audit_log(tenant_id, created_at);

      CREATE TABLE IF NOT EXISTS pending_mutations (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        command_type text NOT NULL,
        actor_id text NOT NULL,
        source text NOT NULL,
        payload_json jsonb NOT NULL,
        target_thread_id text,
        created_at timestamptz NOT NULL DEFAULT now(),
        rejected_reason text,
        status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected'))
      );
      CREATE INDEX IF NOT EXISTS pending_thread_idx ON pending_mutations(tenant_id, target_thread_id);
      CREATE INDEX IF NOT EXISTS pending_status_idx ON pending_mutations(tenant_id, status);

      CREATE TABLE IF NOT EXISTS sync_state (
        mailbox_id text PRIMARY KEY REFERENCES mailboxes(id),
        last_idle_at timestamptz,
        last_error text
      );

      CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
    `,
  },
  {
    id: "0002_fts",
    up: `
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS fts tsvector;
      CREATE INDEX IF NOT EXISTS messages_fts_idx ON messages USING GIN(fts);
      CREATE OR REPLACE FUNCTION messages_fts_trigger() RETURNS trigger AS $$
      BEGIN
        NEW.fts := setweight(to_tsvector('simple', coalesce(NEW.subject,'')), 'A')
                || setweight(to_tsvector('simple', coalesce((NEW.from_json->>0)::text,'')), 'B');
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS messages_fts_update ON messages;
      CREATE TRIGGER messages_fts_update BEFORE INSERT OR UPDATE ON messages
        FOR EACH ROW EXECUTE FUNCTION messages_fts_trigger();
    `,
  },
  {
    id: "0003_rls",
    up: `
      ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
      ALTER TABLE mailboxes ENABLE ROW LEVEL SECURITY;
      ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
      ALTER TABLE threads ENABLE ROW LEVEL SECURITY;
      ALTER TABLE attachments_meta ENABLE ROW LEVEL SECURITY;
      ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
      ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
      ALTER TABLE thread_tags ENABLE ROW LEVEL SECURITY;
      ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pending_mutations ENABLE ROW LEVEL SECURITY;

      DO $$ BEGIN CREATE POLICY tenant_iso ON accounts USING (tenant_id = current_setting('mailai.tenant_id', true)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE POLICY tenant_iso ON mailboxes USING (tenant_id = current_setting('mailai.tenant_id', true)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE POLICY tenant_iso ON messages USING (tenant_id = current_setting('mailai.tenant_id', true)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE POLICY tenant_iso ON threads USING (tenant_id = current_setting('mailai.tenant_id', true)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE POLICY tenant_iso ON attachments_meta USING (tenant_id = current_setting('mailai.tenant_id', true)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE POLICY tenant_iso ON comments USING (tenant_id = current_setting('mailai.tenant_id', true)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE POLICY tenant_iso ON tags USING (tenant_id = current_setting('mailai.tenant_id', true)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE POLICY tenant_iso ON thread_tags USING (tenant_id = current_setting('mailai.tenant_id', true)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE POLICY tenant_iso ON audit_log USING (tenant_id = current_setting('mailai.tenant_id', true)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE POLICY tenant_iso ON pending_mutations USING (tenant_id = current_setting('mailai.tenant_id', true)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `,
  },
  {
    id: "0004_inboxes",
    up: `
      CREATE TABLE IF NOT EXISTS inboxes (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        name text NOT NULL,
        description text,
        config jsonb NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE TABLE IF NOT EXISTS inbox_mailboxes (
        inbox_id text NOT NULL REFERENCES inboxes(id),
        account_id text NOT NULL REFERENCES accounts(id),
        mailbox_path text NOT NULL,
        tenant_id text NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS inbox_mailboxes_pk
        ON inbox_mailboxes(inbox_id, account_id, mailbox_path);
      CREATE TABLE IF NOT EXISTS inbox_members (
        inbox_id text NOT NULL REFERENCES inboxes(id),
        user_id text NOT NULL REFERENCES users(id),
        role text NOT NULL CHECK (role IN ('inbox-admin','agent','viewer')),
        tenant_id text NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS inbox_members_pk
        ON inbox_members(inbox_id, user_id);
      ALTER TABLE inboxes ENABLE ROW LEVEL SECURITY;
      ALTER TABLE inbox_mailboxes ENABLE ROW LEVEL SECURITY;
      ALTER TABLE inbox_members ENABLE ROW LEVEL SECURITY;
      DO $$ BEGIN CREATE POLICY tenant_iso ON inboxes USING (tenant_id = current_setting('mailai.tenant_id', true)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE POLICY tenant_iso ON inbox_mailboxes USING (tenant_id = current_setting('mailai.tenant_id', true)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE POLICY tenant_iso ON inbox_members USING (tenant_id = current_setting('mailai.tenant_id', true)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `,
  },
  {
    id: "0005_oauth_accounts",
    up: `
      CREATE TABLE IF NOT EXISTS oauth_accounts (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        user_id text NOT NULL REFERENCES users(id),
        provider text NOT NULL CHECK (provider IN ('google-mail','outlook')),
        email text NOT NULL,
        access_token text NOT NULL,
        refresh_token text,
        token_type text NOT NULL DEFAULT 'Bearer',
        scope text,
        expires_at timestamptz,
        nango_connection_id text,
        nango_provider_config_key text,
        raw_json jsonb,
        status text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','needs-reauth','revoked')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        last_refreshed_at timestamptz
      );
      CREATE UNIQUE INDEX IF NOT EXISTS oauth_accounts_tenant_email_idx
        ON oauth_accounts(tenant_id, provider, email);
      ALTER TABLE oauth_accounts ENABLE ROW LEVEL SECURITY;
      DO $$ BEGIN CREATE POLICY tenant_iso ON oauth_accounts USING (tenant_id = current_setting('mailai.tenant_id', true)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `,
  },
  {
    // Lightweight, OAuth-only message store for the Gmail/Graph REST
    // sync path. Lives alongside the IMAP-shaped `messages` table —
    // not inside it — because Gmail message ids are 16-hex strings and
    // `messages.uid` is a 4-byte integer. Once @mailai/imap-sync grows
    // a real XOAUTH2 path we can backfill into `messages` and drop
    // this; until then it lets the UI surface real mail the moment the
    // popup closes.
    id: "0006_oauth_messages",
    up: `
      CREATE TABLE IF NOT EXISTS oauth_messages (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        oauth_account_id text NOT NULL REFERENCES oauth_accounts(id) ON DELETE CASCADE,
        provider text NOT NULL CHECK (provider IN ('google-mail','outlook')),
        provider_message_id text NOT NULL,
        provider_thread_id text NOT NULL,
        subject text,
        from_name text,
        from_email text,
        to_addr text,
        snippet text NOT NULL DEFAULT '',
        internal_date timestamptz NOT NULL,
        labels_json jsonb NOT NULL DEFAULT '[]'::jsonb,
        unread boolean NOT NULL DEFAULT false,
        fetched_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS oauth_messages_account_msg_idx
        ON oauth_messages(oauth_account_id, provider_message_id);
      CREATE INDEX IF NOT EXISTS oauth_messages_tenant_date_idx
        ON oauth_messages(tenant_id, internal_date DESC);
      CREATE INDEX IF NOT EXISTS oauth_messages_thread_idx
        ON oauth_messages(tenant_id, provider_thread_id);
      ALTER TABLE oauth_messages ENABLE ROW LEVEL SECURITY;
      DO $$ BEGIN CREATE POLICY tenant_iso ON oauth_messages USING (tenant_id = current_setting('mailai.tenant_id', true)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      ALTER TABLE oauth_accounts
        ADD COLUMN IF NOT EXISTS last_synced_at timestamptz,
        ADD COLUMN IF NOT EXISTS last_sync_error text;
    `,
  },
  {
    // Body storage for the OAuth-message store.
    //
    // We deliberately keep the columns nullable: the initial INBOX
    // sync only fetches metadata (one HTTP roundtrip per page) so the
    // user sees their list immediately. Bodies are filled in lazily
    // — either when the reader UI opens a message and calls
    // /api/messages/:id/body, or by a background backfill pass.
    //
    // We store both text/plain and text/html when the provider gives
    // us both; the reader prefers HTML and falls back to text. HTML
    // is sanitized at render time, never on write, so we can always
    // re-sanitize as the policy evolves.
    //
    // body_fetched_at lets the API tell "we tried and it has no body"
    // (NULL → never tried) apart from "it has no body" (set, but
    // body_text and body_html are both NULL).
    id: "0007_oauth_message_bodies",
    up: `
      ALTER TABLE oauth_messages
        ADD COLUMN IF NOT EXISTS body_text text,
        ADD COLUMN IF NOT EXISTS body_html text,
        ADD COLUMN IF NOT EXISTS body_fetched_at timestamptz;
    `,
  },
  {
    // The pending_mutations table backed the human-review queue at
    // /pending. The Notion-Mail overhaul removed that surface — every
    // command runs immediately now, audit_log is the durable trail —
    // so the table and its RLS policy are no longer reachable from
    // application code. We drop it (idempotent on fresh installs) so
    // dev databases stay in sync with the new schema.
    id: "0008_drop_pending_mutations",
    up: `
      DROP TABLE IF EXISTS pending_mutations CASCADE;
    `,
  },
  {
    // Bridge table that lets us tag OAuth-side conversations
    // (provider_thread_id) without forcing a synthetic row in the
    // IMAP-shaped `threads` table. The user-applied tag definitions
    // themselves live in the existing `tags` table.
    //
    // We add `created_by` so AI-applied tags (a future `mail:classify`
    // command) can be filtered separately from manual ones without an
    // extra column on `tags`.
    id: "0009_oauth_thread_tags",
    up: `
      CREATE TABLE IF NOT EXISTS oauth_thread_tags (
        tenant_id text NOT NULL,
        provider_thread_id text NOT NULL,
        tag_id text NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        added_at timestamptz NOT NULL DEFAULT now(),
        added_by text REFERENCES users(id),
        PRIMARY KEY (tenant_id, provider_thread_id, tag_id)
      );
      CREATE INDEX IF NOT EXISTS oauth_thread_tags_thread_idx
        ON oauth_thread_tags(tenant_id, provider_thread_id);
      CREATE INDEX IF NOT EXISTS oauth_thread_tags_tag_idx
        ON oauth_thread_tags(tenant_id, tag_id);
      ALTER TABLE oauth_thread_tags ENABLE ROW LEVEL SECURITY;
      DO $$ BEGIN CREATE POLICY tenant_iso ON oauth_thread_tags USING (tenant_id = current_setting('mailai.tenant_id', true)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `,
  },
  {
    // Per-user thread state (snooze + done) for OAuth-side
    // conversations. Lives apart from the IMAP `threads` table for
    // the same reason oauth_thread_tags does. Required because in a
    // shared inbox each member can mark their own copy of the thread
    // done independently.
    //
    // status='snoozed' rows carry `snoozed_until`; the views layer
    // wakes them up lazily by running a tiny UPDATE on every read of
    // a status=open or status=snoozed view.
    id: "0010_oauth_thread_state",
    up: `
      CREATE TABLE IF NOT EXISTS oauth_thread_state (
        tenant_id text NOT NULL,
        user_id text NOT NULL REFERENCES users(id),
        provider_thread_id text NOT NULL,
        status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','snoozed','done')),
        snoozed_until timestamptz,
        done_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, user_id, provider_thread_id)
      );
      CREATE INDEX IF NOT EXISTS oauth_thread_state_user_status_idx
        ON oauth_thread_state(tenant_id, user_id, status);
      ALTER TABLE oauth_thread_state ENABLE ROW LEVEL SECURITY;
      DO $$ BEGIN CREATE POLICY tenant_iso ON oauth_thread_state USING (tenant_id = current_setting('mailai.tenant_id', true)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `,
  },
  {
    // Saved views (filter + sort + group). is_builtin distinguishes
    // the seeded defaults (Inbox / Drafts / Sent / Snoozed / Done /
    // All Mail) from user-created tabs — the UI hides delete/rename
    // for builtins.
    id: "0011_views",
    up: `
      CREATE TABLE IF NOT EXISTS views (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        user_id text NOT NULL REFERENCES users(id),
        name text NOT NULL,
        icon text,
        position integer NOT NULL DEFAULT 0,
        is_builtin boolean NOT NULL DEFAULT false,
        filter_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        sort_by text NOT NULL DEFAULT 'date_desc',
        group_by text,
        layout text NOT NULL DEFAULT 'list',
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS views_user_position_idx ON views(tenant_id, user_id, position);
      ALTER TABLE views ENABLE ROW LEVEL SECURITY;
      DO $$ BEGIN CREATE POLICY tenant_iso ON views USING (tenant_id = current_setting('mailai.tenant_id', true)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `,
  },
  {
    // Overlay-only drafts. Drafts never round-trip to the provider
    // (per the Notion-Mail-overhaul plan), so this is the single
    // source of truth. On send we dispatch mail:send / mail:reply and
    // delete the draft row.
    id: "0012_drafts",
    up: `
      CREATE TABLE IF NOT EXISTS drafts (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        user_id text NOT NULL REFERENCES users(id),
        oauth_account_id text REFERENCES oauth_accounts(id) ON DELETE SET NULL,
        reply_to_message_id text,
        provider_thread_id text,
        to_addr jsonb NOT NULL DEFAULT '[]'::jsonb,
        cc_addr jsonb NOT NULL DEFAULT '[]'::jsonb,
        bcc_addr jsonb NOT NULL DEFAULT '[]'::jsonb,
        subject text,
        body_html text,
        body_text text,
        scheduled_send_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS drafts_user_idx ON drafts(tenant_id, user_id, updated_at DESC);
      ALTER TABLE drafts ENABLE ROW LEVEL SECURITY;
      DO $$ BEGIN CREATE POLICY tenant_iso ON drafts USING (tenant_id = current_setting('mailai.tenant_id', true)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `,
  },
  {
    // Calendar tables. Two providers, one shape — matches the gmail
    // / graph mail tables where the model is "we cache provider rows
    // we've seen, keyed by their stable provider id".
    //
    // ical_uid lets us match an event to a .ics part captured from
    // an email message body (RFC 5545 invitations).
    id: "0013_calendar",
    up: `
      CREATE TABLE IF NOT EXISTS calendars (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        oauth_account_id text NOT NULL REFERENCES oauth_accounts(id) ON DELETE CASCADE,
        provider text NOT NULL CHECK (provider IN ('google-cal','outlook')),
        provider_calendar_id text NOT NULL,
        name text NOT NULL,
        color text,
        is_primary boolean NOT NULL DEFAULT false,
        is_visible boolean NOT NULL DEFAULT true,
        fetched_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (oauth_account_id, provider_calendar_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        calendar_id text NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
        provider_event_id text NOT NULL,
        ical_uid text,
        summary text,
        description text,
        location text,
        starts_at timestamptz NOT NULL,
        ends_at timestamptz NOT NULL,
        all_day boolean NOT NULL DEFAULT false,
        attendees_json jsonb NOT NULL DEFAULT '[]'::jsonb,
        organizer_email text,
        response_status text,
        status text,
        recurrence_json jsonb,
        raw_json jsonb,
        fetched_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (calendar_id, provider_event_id)
      );
      CREATE INDEX IF NOT EXISTS events_tenant_time_idx ON events(tenant_id, starts_at);
      CREATE INDEX IF NOT EXISTS events_ical_uid_idx ON events(tenant_id, ical_uid) WHERE ical_uid IS NOT NULL;
      ALTER TABLE calendars ENABLE ROW LEVEL SECURITY;
      ALTER TABLE events ENABLE ROW LEVEL SECURITY;
      DO $$ BEGIN CREATE POLICY tenant_iso ON calendars USING (tenant_id = current_setting('mailai.tenant_id', true)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE POLICY tenant_iso ON events USING (tenant_id = current_setting('mailai.tenant_id', true)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      ALTER TABLE oauth_messages ADD COLUMN IF NOT EXISTS body_ics text;
    `,
  },
  {
    // Full-feature email overhaul.
    //   - oauth_attachments: one row per real attachment seen on a
    //     synced or sent message. Bytes live in S3 at object_key; the
    //     row is created the moment sync sees the part metadata, and
    //     the bytes are lazily fetched on first download.
    //   - draft_attachments: in-flight composer uploads. A separate
    //     namespace (`drafts/<draft_id>/att/<file_id>`) so discarding
    //     a draft can wipe the whole subtree without touching any
    //     landed message.
    //   - oauth_accounts.signature_html / signature_text: per-account
    //     signature served by the composer + reply.
    //   - oauth_messages.has_attachments / starred: cheap flags so
    //     list views can render indicators without joining.
    id: "0014_attachments_signatures",
    up: `
      CREATE TABLE IF NOT EXISTS oauth_attachments (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        oauth_account_id text NOT NULL REFERENCES oauth_accounts(id) ON DELETE CASCADE,
        provider_message_id text NOT NULL,
        provider_attachment_id text,
        object_key text NOT NULL,
        filename text,
        mime text NOT NULL DEFAULT 'application/octet-stream',
        size_bytes bigint NOT NULL DEFAULT 0,
        content_id text,
        is_inline boolean NOT NULL DEFAULT false,
        cached_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS oauth_attachments_account_msg_idx
        ON oauth_attachments(oauth_account_id, provider_message_id);
      CREATE INDEX IF NOT EXISTS oauth_attachments_cid_idx
        ON oauth_attachments(tenant_id, content_id) WHERE content_id IS NOT NULL;
      ALTER TABLE oauth_attachments ENABLE ROW LEVEL SECURITY;
      DO $$ BEGIN CREATE POLICY tenant_iso ON oauth_attachments USING (tenant_id = current_setting('mailai.tenant_id', true)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      CREATE TABLE IF NOT EXISTS draft_attachments (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        user_id text NOT NULL REFERENCES users(id),
        draft_id text REFERENCES drafts(id) ON DELETE CASCADE,
        object_key text NOT NULL,
        filename text NOT NULL,
        mime text NOT NULL DEFAULT 'application/octet-stream',
        size_bytes bigint NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS draft_attachments_draft_idx
        ON draft_attachments(tenant_id, draft_id);
      CREATE INDEX IF NOT EXISTS draft_attachments_user_idx
        ON draft_attachments(tenant_id, user_id);
      ALTER TABLE draft_attachments ENABLE ROW LEVEL SECURITY;
      DO $$ BEGIN CREATE POLICY tenant_iso ON draft_attachments USING (tenant_id = current_setting('mailai.tenant_id', true)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      ALTER TABLE oauth_accounts
        ADD COLUMN IF NOT EXISTS signature_html text,
        ADD COLUMN IF NOT EXISTS signature_text text;

      ALTER TABLE oauth_messages
        ADD COLUMN IF NOT EXISTS has_attachments boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS starred boolean NOT NULL DEFAULT false;
    `,
  },
  {
    // Calendar invites + conferencing.
    //
    // - sequence: RFC 5546 SEQUENCE counter; bumped each time the
    //   calendar handler emits a REQUEST or CANCEL iTIP message so the
    //   recipient client can tell update-from-original.
    // - meeting_provider / meeting_join_url: the conferencing link
    //   minted by the upstream provider (Google Meet via
    //   conferenceData, Teams via isOnlineMeeting). NULL when the user
    //   created an event without a meeting link.
    id: "0015_event_invites",
    up: `
      ALTER TABLE events
        ADD COLUMN IF NOT EXISTS sequence integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS meeting_provider text,
        ADD COLUMN IF NOT EXISTS meeting_join_url text;
    `,
  },
  {
    // Per-account address book cache (recipient autocomplete in the
    // composer). Provider data is the source of truth — this table
    // exists only so the suggest endpoint stays fast and works while
    // the provider is rate-limiting.
    //
    //   - source distinguishes the populations the providers surface
    //     separately. 'other' (Google) and 'people' (Graph) are the
    //     ones that auto-collect anyone the user has emailed, so they
    //     match the Gmail "type 'jt' → suggest jt.hoetter@gmail.com"
    //     experience without any extra harvesting on our side.
    //   - primary_email is stored lower-cased; the index is therefore
    //     directly usable for ILIKE 'q%' lookups without per-row
    //     lower() at query time.
    //   - The pg_trgm GIN index lets the suggest endpoint stay
    //     responsive on substring matches as the table grows. The
    //     extension is created idempotently so fresh installs don't
    //     need to pre-provision it.
    //   - oauth_contacts cascades on oauth_account_id so disconnecting
    //     a mailbox purges its contacts — matches the overlay
    //     isolation rule we hold every cache to.
    id: "0016_oauth_contacts",
    up: `
      CREATE EXTENSION IF NOT EXISTS pg_trgm;

      CREATE TABLE IF NOT EXISTS oauth_contacts (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        oauth_account_id text NOT NULL REFERENCES oauth_accounts(id) ON DELETE CASCADE,
        provider text NOT NULL CHECK (provider IN ('google-mail','outlook')),
        provider_contact_id text NOT NULL,
        source text NOT NULL CHECK (source IN ('my','other','people')),
        display_name text,
        primary_email text NOT NULL,
        emails_json jsonb NOT NULL DEFAULT '[]'::jsonb,
        last_interaction_at timestamptz,
        fetched_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS oauth_contacts_account_contact_idx
        ON oauth_contacts(oauth_account_id, provider_contact_id);
      CREATE INDEX IF NOT EXISTS oauth_contacts_tenant_email_idx
        ON oauth_contacts(tenant_id, primary_email);
      CREATE INDEX IF NOT EXISTS oauth_contacts_tenant_name_idx
        ON oauth_contacts(tenant_id, display_name);
      CREATE INDEX IF NOT EXISTS oauth_contacts_trgm_idx
        ON oauth_contacts USING GIN (
          (lower(coalesce(display_name,'') || ' ' || primary_email)) gin_trgm_ops
        );
      ALTER TABLE oauth_contacts ENABLE ROW LEVEL SECURITY;
      DO $$ BEGIN CREATE POLICY tenant_iso ON oauth_contacts USING (tenant_id = current_setting('mailai.tenant_id', true)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `,
  },
];

export async function runMigrations(pool: Pool): Promise<void> {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const applied = new Set(
    (await pool.query<{ id: string }>("SELECT id FROM schema_migrations")).rows.map((r) => r.id),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(m.up);
      await client.query("INSERT INTO schema_migrations(id) VALUES ($1)", [m.id]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
