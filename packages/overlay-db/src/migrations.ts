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
