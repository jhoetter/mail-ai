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
    // Per-account email signature. We store both an HTML rendition
    // (the canonical version edited via RichEditor) and a plain-text
    // mirror so the multipart/alternative envelope keeps a faithful
    // text fallback. Either column may be NULL if the user hasn't
    // configured one.
    signatureHtml: text("signature_html"),
    signatureText: text("signature_text"),
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
    // Cheap flags so list views can render attachment / star
    // indicators without joining `oauth_attachments` or parsing
    // `labels_json`. Kept in sync by the sync worker.
    hasAttachments: boolean("has_attachments").notNull().default(false),
    starred: boolean("starred").notNull().default(false),
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

// Real (sent or received) attachments. Keyed by mail-ai's own `id` so
// the API can reference a stable URL (`/api/attachments/:id`) without
// leaking provider ids. The byte stream lives in S3 at `objectKey`;
// the row is created when sync sees the part metadata, and the bytes
// are lazily fetched on first download.
//
// `providerAttachmentId` is the provider-side handle we need to ask
// Gmail / Graph for the bytes when we don't have them cached yet.
// `contentId` (without angle brackets) lets the HTML renderer rewrite
// `<img src="cid:…">` to our /inline route.
export const oauthAttachments = pgTable(
  "oauth_attachments",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    oauthAccountId: text("oauth_account_id")
      .references(() => oauthAccounts.id, { onDelete: "cascade" })
      .notNull(),
    providerMessageId: text("provider_message_id").notNull(),
    providerAttachmentId: text("provider_attachment_id"),
    objectKey: text("object_key").notNull(),
    filename: text("filename"),
    mime: text("mime").notNull().default("application/octet-stream"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    contentId: text("content_id"),
    isInline: boolean("is_inline").notNull().default(false),
    cachedAt: timestamp("cached_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    msgIdx: index("oauth_attachments_account_msg_idx").on(
      t.oauthAccountId,
      t.providerMessageId,
    ),
    cidIdx: index("oauth_attachments_cid_idx").on(t.tenantId, t.contentId),
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

// In-flight composer uploads. Lives apart from oauth_attachments
// because (a) the row is created by the browser before any real
// message exists, and (b) the byte tree gets a different S3 prefix
// (`drafts/<draft_id>/att/<file_id>`) so we can wipe a draft tree on
// discard without touching landed messages.
//
// On send we copy/rename the bytes into the message namespace and
// insert mirror rows into `oauth_attachments` keyed by the new
// providerMessageId.
export const draftAttachments = pgTable(
  "draft_attachments",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").references(() => users.id).notNull(),
    draftId: text("draft_id").references(() => drafts.id, { onDelete: "cascade" }),
    objectKey: text("object_key").notNull(),
    filename: text("filename").notNull(),
    mime: text("mime").notNull().default("application/octet-stream"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    draftIdx: index("draft_attachments_draft_idx").on(t.tenantId, t.draftId),
    userIdx: index("draft_attachments_user_idx").on(t.tenantId, t.userId),
  }),
);

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

// Per-account address book cache. Mirrors `oauth_messages` /
// `events`: provider data is the source of truth, we cache locally so
// recipient autocomplete in the composer is sub-50ms and survives
// provider rate limits.
//
// `source` distinguishes the three populations Gmail-style clients
// surface separately:
//   - 'my'     → explicit contacts (Google `people/me/connections`,
//                Graph `/me/contacts`)
//   - 'other'  → auto-collected from anyone the user has emailed
//                (Google `otherContacts`)
//   - 'people' → MS Graph's intelligent ranked suggestions
//                (`/me/people`); the closest analogue to Gmail's
//                'Other Contacts' for Outlook accounts.
//
// `primary_email` is stored lower-cased so the `ILIKE` prefix match
// in `searchContacts` can hit the per-tenant index without lowering
// every row at query time.
export const oauthContacts = pgTable(
  "oauth_contacts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    oauthAccountId: text("oauth_account_id")
      .references(() => oauthAccounts.id, { onDelete: "cascade" })
      .notNull(),
    provider: text("provider").notNull(), // 'google-mail' | 'outlook'
    providerContactId: text("provider_contact_id").notNull(),
    source: text("source").notNull(), // 'my' | 'other' | 'people'
    displayName: text("display_name"),
    primaryEmail: text("primary_email").notNull(),
    emailsJson: jsonb("emails_json").notNull(),
    lastInteractionAt: timestamp("last_interaction_at", { withTimezone: true }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    contactIdx: uniqueIndex("oauth_contacts_account_contact_idx").on(
      t.oauthAccountId,
      t.providerContactId,
    ),
    emailIdx: index("oauth_contacts_tenant_email_idx").on(
      t.tenantId,
      t.primaryEmail,
    ),
    nameIdx: index("oauth_contacts_tenant_name_idx").on(
      t.tenantId,
      t.displayName,
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
    // RFC 5546 SEQUENCE counter. We persist what we've sent / received
    // so update + cancel iTIP messages monotonically increase. Starts
    // at 0 on create and is bumped by the calendar handler before each
    // outgoing REQUEST/CANCEL.
    sequence: integer("sequence").notNull().default(0),
    // Conferencing wired to the event. NULL when the user picked "no
    // meeting link" or the row was synced from upstream where we
    // haven't (yet) parsed the conference data.
    meetingProvider: text("meeting_provider"), // 'google-meet' | 'ms-teams'
    meetingJoinUrl: text("meeting_join_url"),
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
