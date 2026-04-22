// Re-export the pg Pool type so callers (e.g. @mailai/server) can hold
// a typed pool reference without importing 'pg' directly — the
// architecture check pins `pg` to this package only.
export type { Pool } from "pg";
export * from "./schema.js";
export * from "./client.js";
export * from "./repositories/accounts.js";
export * from "./repositories/oauth-accounts.js";
export * from "./repositories/oauth-messages.js";
export * from "./repositories/messages.js";
export * from "./repositories/threads.js";
export * from "./repositories/audit.js";
export * from "./repositories/comments.js";
export * from "./repositories/tags.js";
export * from "./repositories/oauth-thread-tags.js";
export * from "./repositories/oauth-thread-state.js";
export * from "./repositories/views.js";
export * from "./repositories/drafts.js";
export * from "./repositories/calendar.js";
export * from "./repositories/attachments.js";
export * from "./repositories/oauth-attachments.js";
export * from "./repositories/oauth-contacts.js";
export * from "./repositories/draft-attachments.js";
export * from "./repositories/inboxes.js";
export * from "./migrations.js";
export * from "./threading.js";
export * from "./search.js";
export * from "./attachments-store.js";
export * from "./object-store-s3.js";
export * from "./dedup.js";
export * from "./plugin.js";
