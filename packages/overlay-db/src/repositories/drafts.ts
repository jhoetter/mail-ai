// Drafts repository (overlay-only). Drafts never round-trip to the
// provider — the user's draft list is a pure mail-ai construct. On
// send, the route dispatches mail:send / mail:reply through the bus
// and deletes the draft row in the same transaction.

import { and, desc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Database } from "../client.js";
import { drafts } from "../schema.js";

export interface DraftRow {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly oauthAccountId: string | null;
  readonly replyToMessageId: string | null;
  readonly providerThreadId: string | null;
  readonly toAddr: string[];
  readonly ccAddr: string[];
  readonly bccAddr: string[];
  readonly subject: string | null;
  readonly bodyHtml: string | null;
  readonly bodyText: string | null;
  readonly scheduledSendAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DraftInsert {
  readonly tenantId: string;
  readonly userId: string;
  readonly oauthAccountId?: string | null;
  readonly replyToMessageId?: string | null;
  readonly providerThreadId?: string | null;
  readonly to?: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly subject?: string | null;
  readonly bodyHtml?: string | null;
  readonly bodyText?: string | null;
}

export interface DraftPatch {
  readonly to?: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly subject?: string | null;
  readonly bodyHtml?: string | null;
  readonly bodyText?: string | null;
}

export class DraftsRepository {
  constructor(private readonly db: Database) {}

  async create(input: DraftInsert): Promise<DraftRow> {
    const id = `draft_${randomUUID()}`;
    await this.db.execute(sql`
      INSERT INTO drafts (
        id, tenant_id, user_id, oauth_account_id, reply_to_message_id,
        provider_thread_id, to_addr, cc_addr, bcc_addr,
        subject, body_html, body_text
      ) VALUES (
        ${id}, ${input.tenantId}, ${input.userId},
        ${input.oauthAccountId ?? null}, ${input.replyToMessageId ?? null},
        ${input.providerThreadId ?? null},
        ${JSON.stringify(input.to ?? [])}::jsonb,
        ${JSON.stringify(input.cc ?? [])}::jsonb,
        ${JSON.stringify(input.bcc ?? [])}::jsonb,
        ${input.subject ?? null},
        ${input.bodyHtml ?? null},
        ${input.bodyText ?? null}
      )
    `);
    const row = await this.byId(input.tenantId, input.userId, id);
    if (!row) throw new Error(`drafts.create: lost row ${id}`);
    return row;
  }

  async update(
    tenantId: string,
    userId: string,
    id: string,
    patch: DraftPatch,
  ): Promise<DraftRow | null> {
    // Build the patch incrementally; jsonb columns need explicit
    // cast or we'd get text confusion in pg.
    const setFragments: ReturnType<typeof sql>[] = [sql`updated_at = now()`];
    if (patch.to !== undefined)
      setFragments.push(sql`to_addr = ${JSON.stringify(patch.to)}::jsonb`);
    if (patch.cc !== undefined)
      setFragments.push(sql`cc_addr = ${JSON.stringify(patch.cc)}::jsonb`);
    if (patch.bcc !== undefined)
      setFragments.push(sql`bcc_addr = ${JSON.stringify(patch.bcc)}::jsonb`);
    if (patch.subject !== undefined) setFragments.push(sql`subject = ${patch.subject}`);
    if (patch.bodyHtml !== undefined) setFragments.push(sql`body_html = ${patch.bodyHtml}`);
    if (patch.bodyText !== undefined) setFragments.push(sql`body_text = ${patch.bodyText}`);

    const setClause = sql.join(setFragments, sql`, `);
    await this.db.execute(sql`
      UPDATE drafts SET ${setClause}
      WHERE tenant_id = ${tenantId} AND user_id = ${userId} AND id = ${id}
    `);
    return this.byId(tenantId, userId, id);
  }

  async delete(tenantId: string, userId: string, id: string): Promise<void> {
    await this.db
      .delete(drafts)
      .where(
        and(
          eq(drafts.tenantId, tenantId),
          eq(drafts.userId, userId),
          eq(drafts.id, id),
        ),
      );
  }

  async byId(tenantId: string, userId: string, id: string): Promise<DraftRow | null> {
    const rows = await this.db
      .select()
      .from(drafts)
      .where(
        and(
          eq(drafts.tenantId, tenantId),
          eq(drafts.userId, userId),
          eq(drafts.id, id),
        ),
      );
    return (rows[0] as DraftRow | undefined) ?? null;
  }

  async listByUser(
    tenantId: string,
    userId: string,
    limit = 100,
  ): Promise<DraftRow[]> {
    const rows = await this.db
      .select()
      .from(drafts)
      .where(and(eq(drafts.tenantId, tenantId), eq(drafts.userId, userId)))
      .orderBy(desc(drafts.updatedAt))
      .limit(limit);
    return rows as DraftRow[];
  }
}
