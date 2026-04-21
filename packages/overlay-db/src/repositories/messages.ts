import { and, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { messages } from "../schema.js";

export interface MessageRow {
  readonly id: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly mailboxId: string;
  readonly uid: number;
  readonly messageId: string | null;
  readonly threadId: string | null;
  readonly subject: string | null;
  readonly fromJson: unknown;
  readonly toJson: unknown;
  readonly inReplyTo: string | null;
  readonly referencesJson: unknown;
  readonly flagsJson: unknown;
  readonly sizeBytes: number;
  readonly internalDate: Date;
  readonly bodyTextRef: string | null;
  readonly bodyHtmlRef: string | null;
  readonly rawRef: string;
}

export class MessagesRepository {
  constructor(private readonly db: Database) {}

  async byMailboxUid(mailboxId: string, uid: number): Promise<MessageRow | null> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.mailboxId, mailboxId), eq(messages.uid, uid)));
    return (rows[0] as MessageRow | undefined) ?? null;
  }

  async upsert(row: MessageRow): Promise<void> {
    // ON CONFLICT (mailbox_id, uid) DO UPDATE — kept tiny on purpose;
    // a dedicated `dedupByMessageId` helper handles cross-folder dedup
    // in Phase 2.
    await this.db
      .insert(messages)
      .values(row)
      .onConflictDoUpdate({
        target: [messages.mailboxId, messages.uid],
        set: { flagsJson: row.flagsJson, threadId: row.threadId, subject: row.subject },
      });
  }
}
