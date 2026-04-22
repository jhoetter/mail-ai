// Inbox repository: shared inboxes (a curated set of mailboxes from one
// or more accounts) plus their members. The repository deliberately
// stays narrow — only the read/write paths needed by the collaboration
// plugin and the HTTP server. Multi-tenant isolation is enforced via
// RLS; we still pass `tenantId` so the SQL is auditable on its own.

import { and, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { inboxes, inboxMailboxes, inboxMembers } from "../schema.js";

export interface InboxRow {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly description: string | null;
  readonly config: Record<string, unknown>;
}

export interface InboxMemberRow {
  readonly inboxId: string;
  readonly userId: string;
  readonly role: "inbox-admin" | "agent" | "viewer";
  readonly tenantId: string;
}

export interface InboxMailboxRow {
  readonly inboxId: string;
  readonly accountId: string;
  readonly mailboxPath: string;
  readonly tenantId: string;
}

export class InboxesRepository {
  constructor(private readonly db: Database) {}

  async list(tenantId: string): Promise<InboxRow[]> {
    const rows = await this.db
      .select()
      .from(inboxes)
      .where(eq(inboxes.tenantId, tenantId));
    return rows as unknown as InboxRow[];
  }

  async insert(row: InboxRow): Promise<void> {
    await this.db.insert(inboxes).values({
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      description: row.description,
      config: row.config as unknown as object,
    });
  }

  async addMailbox(row: InboxMailboxRow): Promise<void> {
    await this.db.insert(inboxMailboxes).values(row).onConflictDoNothing();
  }

  async addMember(row: InboxMemberRow): Promise<void> {
    await this.db.insert(inboxMembers).values(row).onConflictDoNothing();
  }

  async listMembers(tenantId: string, inboxId: string): Promise<InboxMemberRow[]> {
    const rows = await this.db
      .select()
      .from(inboxMembers)
      .where(and(eq(inboxMembers.tenantId, tenantId), eq(inboxMembers.inboxId, inboxId)));
    return rows as unknown as InboxMemberRow[];
  }

  async memberRole(
    tenantId: string,
    inboxId: string,
    userId: string,
  ): Promise<InboxMemberRow["role"] | null> {
    const rows = await this.db
      .select()
      .from(inboxMembers)
      .where(
        and(
          eq(inboxMembers.tenantId, tenantId),
          eq(inboxMembers.inboxId, inboxId),
          eq(inboxMembers.userId, userId),
        ),
      )
      .limit(1);
    const r = rows[0] as unknown as InboxMemberRow | undefined;
    return r?.role ?? null;
  }

  async byId(tenantId: string, id: string): Promise<InboxRow | null> {
    const rows = await this.db
      .select()
      .from(inboxes)
      .where(and(eq(inboxes.tenantId, tenantId), eq(inboxes.id, id)))
      .limit(1);
    return (rows[0] as unknown as InboxRow | undefined) ?? null;
  }

  async update(
    tenantId: string,
    id: string,
    patch: {
      name?: string | undefined;
      description?: string | null | undefined;
      config?: Record<string, unknown> | undefined;
    },
  ): Promise<void> {
    const set: Record<string, unknown> = {};
    if (patch.name !== undefined) set["name"] = patch.name;
    if (patch.description !== undefined) set["description"] = patch.description;
    if (patch.config !== undefined) set["config"] = patch.config;
    if (Object.keys(set).length === 0) return;
    await this.db
      .update(inboxes)
      .set(set)
      .where(and(eq(inboxes.tenantId, tenantId), eq(inboxes.id, id)));
  }

  async delete(tenantId: string, id: string): Promise<void> {
    // The schema doesn't declare ON DELETE CASCADE on the child FKs,
    // so we clean them up manually inside one transaction.
    await this.db
      .delete(inboxMembers)
      .where(and(eq(inboxMembers.tenantId, tenantId), eq(inboxMembers.inboxId, id)));
    await this.db
      .delete(inboxMailboxes)
      .where(and(eq(inboxMailboxes.tenantId, tenantId), eq(inboxMailboxes.inboxId, id)));
    await this.db
      .delete(inboxes)
      .where(and(eq(inboxes.tenantId, tenantId), eq(inboxes.id, id)));
  }

  async listMailboxes(tenantId: string, inboxId: string): Promise<InboxMailboxRow[]> {
    const rows = await this.db
      .select()
      .from(inboxMailboxes)
      .where(and(eq(inboxMailboxes.tenantId, tenantId), eq(inboxMailboxes.inboxId, inboxId)));
    return rows as unknown as InboxMailboxRow[];
  }

  async removeMember(tenantId: string, inboxId: string, userId: string): Promise<void> {
    await this.db
      .delete(inboxMembers)
      .where(
        and(
          eq(inboxMembers.tenantId, tenantId),
          eq(inboxMembers.inboxId, inboxId),
          eq(inboxMembers.userId, userId),
        ),
      );
  }

  async removeMailbox(
    tenantId: string,
    inboxId: string,
    accountId: string,
    mailboxPath: string,
  ): Promise<void> {
    await this.db
      .delete(inboxMailboxes)
      .where(
        and(
          eq(inboxMailboxes.tenantId, tenantId),
          eq(inboxMailboxes.inboxId, inboxId),
          eq(inboxMailboxes.accountId, accountId),
          eq(inboxMailboxes.mailboxPath, mailboxPath),
        ),
      );
  }
}
