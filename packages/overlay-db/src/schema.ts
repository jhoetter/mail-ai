// Drizzle ORM schema definitions. The full SQL DDL with indexes and
// constraints lives in src/migrations.ts so we have plain SQL we can
// hand to Postgres in any environment (CI, prod, dev).
//
// All tables include `tenant_id` for row-level security; phase-2 spec
// pinned RLS as the multi-tenant isolation strategy because it lets a
// single backend serve many orgs without a connection-per-tenant
// explosion.

import {
  bigint,
  bigserial,
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").references(() => tenants.id).notNull(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  role: text("role").notNull(), // 'admin' | 'member' | 'read-only'
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").references(() => users.id).notNull(),
    provider: text("provider").notNull(),
    address: text("address").notNull(),
    imapHost: text("imap_host").notNull(),
    imapPort: integer("imap_port").notNull(),
    smtpHost: text("smtp_host").notNull(),
    smtpPort: integer("smtp_port").notNull(),
    credentialBlob: text("credential_blob").notNull(), // encrypted JSON
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    addrIdx: uniqueIndex("accounts_tenant_addr_idx").on(t.tenantId, t.address),
  }),
);

// OAuth-connected mail accounts (Gmail / Outlook). Kept separate from
// `accounts` because the latter requires IMAP host/port/credentials up
// front, and we want OAuth wiring to land independently of the IMAP
// pool. Once we wire @mailai/imap-sync to XOAUTH2 we can either join
// here or migrate to a single accounts table — see oauth_accounts.md.
export const oauthAccounts = pgTable(
  "oauth_accounts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").references(() => users.id).notNull(),
    provider: text("provider").notNull(), // 'google-mail' | 'outlook'
    email: text("email").notNull(),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
    tokenType: text("token_type").notNull().default("Bearer"),
    scope: text("scope"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    nangoConnectionId: text("nango_connection_id"),
    nangoProviderConfigKey: text("nango_provider_config_key"),
    rawJson: jsonb("raw_json"), // full Nango connection payload for debugging
    status: text("status").notNull().default("ok"), // 'ok' | 'needs-reauth' | 'revoked'
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
  },
  (t) => ({
    emailIdx: uniqueIndex("oauth_accounts_tenant_email_idx").on(
      t.tenantId,
      t.provider,
      t.email,
    ),
  }),
);

export const mailboxes = pgTable("mailboxes", {
  id: text("id").primaryKey(),
  accountId: text("account_id").references(() => accounts.id).notNull(),
  tenantId: text("tenant_id").notNull(),
  path: text("path").notNull(),
  delimiter: text("delimiter").notNull(),
  specialUse: text("special_use"),
  isShared: boolean("is_shared").default(false).notNull(),
  uidValidity: bigint("uid_validity", { mode: "number" }).notNull(),
  highestModSeq: bigint("highest_mod_seq", { mode: "bigint" }),
  lastSyncedUid: integer("last_synced_uid").default(0).notNull(),
  lastFetchAt: timestamp("last_fetch_at", { withTimezone: true }),
});

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    accountId: text("account_id").references(() => accounts.id).notNull(),
    mailboxId: text("mailbox_id").references(() => mailboxes.id).notNull(),
    uid: integer("uid").notNull(),
    messageId: text("message_id"),
    threadId: text("thread_id"),
    subject: text("subject"),
    fromJson: jsonb("from_json").notNull(),
    toJson: jsonb("to_json").notNull(),
    ccJson: jsonb("cc_json"),
    inReplyTo: text("in_reply_to"),
    referencesJson: jsonb("references_json"),
    flagsJson: jsonb("flags_json").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    internalDate: timestamp("internal_date", { withTimezone: true }).notNull(),
    bodyTextRef: text("body_text_ref"), // S3 key for plaintext body
    bodyHtmlRef: text("body_html_ref"),
    rawRef: text("raw_ref").notNull(), // S3 key for full MIME source
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uidIdx: uniqueIndex("messages_mailbox_uid_idx").on(t.mailboxId, t.uid),
    threadIdx: index("messages_thread_idx").on(t.tenantId, t.threadId),
    msgidIdx: index("messages_msgid_idx").on(t.tenantId, t.messageId),
  }),
);

export const threads = pgTable(
  "threads",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    accountId: text("account_id").references(() => accounts.id).notNull(),
    rootMessageId: text("root_message_id"),
    subject: text("subject"),
    status: text("status").default("open").notNull(),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    assignedTo: text("assigned_to").references(() => users.id),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    statusIdx: index("threads_tenant_status_idx").on(t.tenantId, t.status),
  }),
);

export const attachmentsMeta = pgTable("attachments_meta", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  messageId: text("message_id").references(() => messages.id).notNull(),
  filename: text("filename"),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  storageRef: text("storage_ref").notNull(),
});

export const tags = pgTable("tags", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  name: text("name").notNull(),
  color: text("color").notNull(),
});

export const threadTags = pgTable(
  "thread_tags",
  {
    threadId: text("thread_id").references(() => threads.id).notNull(),
    tagId: text("tag_id").references(() => tags.id).notNull(),
    tenantId: text("tenant_id").notNull(),
  },
  (t) => ({ pk: uniqueIndex("thread_tags_pk").on(t.threadId, t.tagId) }),
);

export const comments = pgTable("comments", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  threadId: text("thread_id").references(() => threads.id).notNull(),
  authorId: text("author_id").references(() => users.id).notNull(),
  body: text("body").notNull(),
  mentionsJson: jsonb("mentions_json"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  editedAt: timestamp("edited_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const auditLog = pgTable(
  "audit_log",
  {
    seq: bigserial("seq", { mode: "bigint" }).primaryKey(),
    tenantId: text("tenant_id").notNull(),
    mutationId: text("mutation_id").notNull(),
    commandType: text("command_type").notNull(),
    actorId: text("actor_id").notNull(),
    source: text("source").notNull(),
    payloadJson: jsonb("payload_json").notNull(),
    diffJson: jsonb("diff_json"),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    mutIdx: uniqueIndex("audit_log_mut_idx").on(t.mutationId),
    tenantTimeIdx: index("audit_log_tenant_time_idx").on(t.tenantId, t.createdAt),
  }),
);

export const inboxes = pgTable("inboxes", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  config: jsonb("config").notNull(),
});

export const inboxMailboxes = pgTable(
  "inbox_mailboxes",
  {
    inboxId: text("inbox_id").references(() => inboxes.id).notNull(),
    accountId: text("account_id").references(() => accounts.id).notNull(),
    mailboxPath: text("mailbox_path").notNull(),
    tenantId: text("tenant_id").notNull(),
  },
  (t) => ({ pk: uniqueIndex("inbox_mailboxes_pk").on(t.inboxId, t.accountId, t.mailboxPath) }),
);

export const inboxMembers = pgTable(
  "inbox_members",
  {
    inboxId: text("inbox_id").references(() => inboxes.id).notNull(),
    userId: text("user_id").references(() => users.id).notNull(),
    role: text("role").notNull(),
    tenantId: text("tenant_id").notNull(),
  },
  (t) => ({ pk: uniqueIndex("inbox_members_pk").on(t.inboxId, t.userId) }),
);

export const pendingMutations = pgTable(
  "pending_mutations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    commandType: text("command_type").notNull(),
    actorId: text("actor_id").notNull(),
    source: text("source").notNull(),
    payloadJson: jsonb("payload_json").notNull(),
    targetThreadId: text("target_thread_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    rejectedReason: text("rejected_reason"),
    status: text("status").default("pending").notNull(),
  },
  (t) => ({
    threadIdx: index("pending_thread_idx").on(t.tenantId, t.targetThreadId),
    statusIdx: index("pending_status_idx").on(t.tenantId, t.status),
  }),
);
