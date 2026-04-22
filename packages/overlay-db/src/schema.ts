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
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastSyncError: text("last_sync_error"),
  },
  (t) => ({
    emailIdx: uniqueIndex("oauth_accounts_tenant_email_idx").on(
      t.tenantId,
      t.provider,
      t.email,
    ),
  }),
);

// Lightweight message store for the Gmail/Graph REST sync path. See
// migration 0006_oauth_messages for the rationale for not reusing
// `messages` (uid is a 4-byte int; provider ids are 16-hex strings).
export const oauthMessages = pgTable(
  "oauth_messages",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    oauthAccountId: text("oauth_account_id")
      .references(() => oauthAccounts.id, { onDelete: "cascade" })
      .notNull(),
    provider: text("provider").notNull(),
    providerMessageId: text("provider_message_id").notNull(),
    providerThreadId: text("provider_thread_id").notNull(),
    subject: text("subject"),
    fromName: text("from_name"),
    fromEmail: text("from_email"),
    toAddr: text("to_addr"),
    snippet: text("snippet").notNull().default(""),
    internalDate: timestamp("internal_date", { withTimezone: true }).notNull(),
    labelsJson: jsonb("labels_json").notNull(),
    unread: boolean("unread").notNull().default(false),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
    bodyText: text("body_text"),
    bodyHtml: text("body_html"),
    bodyFetchedAt: timestamp("body_fetched_at", { withTimezone: true }),
  },
  (t) => ({
    msgIdx: uniqueIndex("oauth_messages_account_msg_idx").on(
      t.oauthAccountId,
      t.providerMessageId,
    ),
    dateIdx: index("oauth_messages_tenant_date_idx").on(t.tenantId, t.internalDate),
    threadIdx: index("oauth_messages_thread_idx").on(t.tenantId, t.providerThreadId),
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

// pending_mutations was the durable backing for the human-review queue
// at /pending. The Notion-Mail overhaul removed that flow entirely
// (commands run immediately; audit_log is the durable trail), so the
// table is dropped in migration 0008. The Drizzle definition is kept
// off the schema on purpose — re-adding it would let new code reach
// for a queue we no longer support.

// Bridge from the OAuth-side message store to the existing tags
// table. Lets a Gmail/Graph thread carry tags without forcing us to
// invent a synthetic IMAP `threads` row per conversation. See
// migration 0009 for the rationale and the manual-vs-AI distinction.
export const oauthThreadTags = pgTable(
  "oauth_thread_tags",
  {
    tenantId: text("tenant_id").notNull(),
    providerThreadId: text("provider_thread_id").notNull(),
    tagId: text("tag_id")
      .references(() => tags.id, { onDelete: "cascade" })
      .notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).defaultNow().notNull(),
    addedBy: text("added_by").references(() => users.id),
  },
  (t) => ({
    pk: uniqueIndex("oauth_thread_tags_pk").on(
      t.tenantId,
      t.providerThreadId,
      t.tagId,
    ),
  }),
);

// Per-user thread state for OAuth conversations: open / snoozed /
// done. Multi-member shared inboxes need this per-user so two people
// triaging the same thread don't trip over each other's "done".
export const oauthThreadState = pgTable(
  "oauth_thread_state",
  {
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").references(() => users.id).notNull(),
    providerThreadId: text("provider_thread_id").notNull(),
    status: text("status").notNull().default("open"),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    doneAt: timestamp("done_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: uniqueIndex("oauth_thread_state_pk").on(
      t.tenantId,
      t.userId,
      t.providerThreadId,
    ),
  }),
);

// Notion-style saved views (filter + sort + group). Per-user; the
// bus seeds a built-in set on first /api/views read.
export const views = pgTable("views", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  userId: text("user_id").references(() => users.id).notNull(),
  name: text("name").notNull(),
  icon: text("icon"),
  position: integer("position").notNull().default(0),
  isBuiltin: boolean("is_builtin").notNull().default(false),
  filterJson: jsonb("filter_json").notNull(),
  sortBy: text("sort_by").notNull().default("date_desc"),
  groupBy: text("group_by"),
  layout: text("layout").notNull().default("list"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Overlay-only drafts. Multi-device inside mail-ai; provider doesn't
// see them until the user hits Send.
export const drafts = pgTable("drafts", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  userId: text("user_id").references(() => users.id).notNull(),
  oauthAccountId: text("oauth_account_id").references(() => oauthAccounts.id, {
    onDelete: "set null",
  }),
  replyToMessageId: text("reply_to_message_id"),
  providerThreadId: text("provider_thread_id"),
  toAddr: jsonb("to_addr").notNull(),
  ccAddr: jsonb("cc_addr").notNull(),
  bccAddr: jsonb("bcc_addr").notNull(),
  subject: text("subject"),
  bodyHtml: text("body_html"),
  bodyText: text("body_text"),
  scheduledSendAt: timestamp("scheduled_send_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const calendars = pgTable(
  "calendars",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    oauthAccountId: text("oauth_account_id")
      .references(() => oauthAccounts.id, { onDelete: "cascade" })
      .notNull(),
    provider: text("provider").notNull(),
    providerCalendarId: text("provider_calendar_id").notNull(),
    name: text("name").notNull(),
    color: text("color"),
    isPrimary: boolean("is_primary").notNull().default(false),
    isVisible: boolean("is_visible").notNull().default(true),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    providerIdx: uniqueIndex("calendars_account_provider_idx").on(
      t.oauthAccountId,
      t.providerCalendarId,
    ),
  }),
);

export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    calendarId: text("calendar_id")
      .references(() => calendars.id, { onDelete: "cascade" })
      .notNull(),
    providerEventId: text("provider_event_id").notNull(),
    icalUid: text("ical_uid"),
    summary: text("summary"),
    description: text("description"),
    location: text("location"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    allDay: boolean("all_day").notNull().default(false),
    attendeesJson: jsonb("attendees_json").notNull(),
    organizerEmail: text("organizer_email"),
    responseStatus: text("response_status"),
    status: text("status"),
    recurrenceJson: jsonb("recurrence_json"),
    rawJson: jsonb("raw_json"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    eventIdx: uniqueIndex("events_calendar_event_idx").on(
      t.calendarId,
      t.providerEventId,
    ),
    timeIdx: index("events_tenant_time_idx").on(t.tenantId, t.startsAt),
  }),
);
