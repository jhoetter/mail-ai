// Repository for the OAuth-side tag bridge.
//
// The user-facing `tags` table holds the definitions (id, name,
// color); this table records which provider_thread_id carries which
// tag, optionally noting which user added it. We keep two listing
// helpers because the views layer needs both directions: "what tags
// does this thread have" (reader header chips) and "which threads
// carry this tag" (sidebar filter / view predicates).

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { oauthThreadTags, tags } from "../schema.js";
import type { TagRow } from "./tags.js";

export interface OauthThreadTagRow {
  readonly tenantId: string;
  readonly providerThreadId: string;
  readonly tagId: string;
  readonly addedAt: Date;
  readonly addedBy: string | null;
}

export interface ThreadTagSummary extends TagRow {
  readonly addedAt: Date;
  readonly addedBy: string | null;
}

export class OauthThreadTagsRepository {
  constructor(private readonly db: Database) {}

  async add(
    tenantId: string,
    providerThreadId: string,
    tagId: string,
    addedBy: string | null,
  ): Promise<void> {
    // ON CONFLICT keeps re-tagging idempotent — clicking "tag" twice
    // never errors and never bumps added_at, which would lie about
    // when the tag was first applied.
    await this.db.execute(sql`
      INSERT INTO oauth_thread_tags (tenant_id, provider_thread_id, tag_id, added_by)
      VALUES (${tenantId}, ${providerThreadId}, ${tagId}, ${addedBy})
      ON CONFLICT (tenant_id, provider_thread_id, tag_id) DO NOTHING
    `);
  }

  async remove(tenantId: string, providerThreadId: string, tagId: string): Promise<void> {
    await this.db
      .delete(oauthThreadTags)
      .where(
        and(
          eq(oauthThreadTags.tenantId, tenantId),
          eq(oauthThreadTags.providerThreadId, providerThreadId),
          eq(oauthThreadTags.tagId, tagId),
        ),
      );
  }

  // Tags currently applied to one thread. Joined to the definitions
  // table so callers get name + color in a single round trip.
  async listForThread(tenantId: string, providerThreadId: string): Promise<ThreadTagSummary[]> {
    const rows = await this.db
      .select({
        id: tags.id,
        tenantId: tags.tenantId,
        name: tags.name,
        color: tags.color,
        addedAt: oauthThreadTags.addedAt,
        addedBy: oauthThreadTags.addedBy,
      })
      .from(oauthThreadTags)
      .innerJoin(tags, eq(tags.id, oauthThreadTags.tagId))
      .where(
        and(
          eq(oauthThreadTags.tenantId, tenantId),
          eq(oauthThreadTags.providerThreadId, providerThreadId),
        ),
      );
    return rows as ThreadTagSummary[];
  }

  // Multi-thread fetch for the inbox list (one query → tags for every
  // visible row). Returns a Map keyed by provider_thread_id so the
  // caller can render chips inline without an N+1 problem.
  async listForThreads(
    tenantId: string,
    providerThreadIds: readonly string[],
  ): Promise<Map<string, ThreadTagSummary[]>> {
    const out = new Map<string, ThreadTagSummary[]>();
    if (providerThreadIds.length === 0) return out;
    const rows = await this.db
      .select({
        providerThreadId: oauthThreadTags.providerThreadId,
        id: tags.id,
        tenantId: tags.tenantId,
        name: tags.name,
        color: tags.color,
        addedAt: oauthThreadTags.addedAt,
        addedBy: oauthThreadTags.addedBy,
      })
      .from(oauthThreadTags)
      .innerJoin(tags, eq(tags.id, oauthThreadTags.tagId))
      .where(
        and(
          eq(oauthThreadTags.tenantId, tenantId),
          inArray(oauthThreadTags.providerThreadId, providerThreadIds as string[]),
        ),
      );
    for (const r of rows) {
      const arr = out.get(r.providerThreadId) ?? [];
      arr.push({
        id: r.id,
        tenantId: r.tenantId,
        name: r.name,
        color: r.color,
        addedAt: r.addedAt as Date,
        addedBy: r.addedBy,
      });
      out.set(r.providerThreadId, arr);
    }
    return out;
  }

  // Provider thread ids carrying any of the given tag ids — drives
  // the "tag filter" view predicate in Phase 4.
  async listThreadIdsWithAnyTag(tenantId: string, tagIds: readonly string[]): Promise<string[]> {
    if (tagIds.length === 0) return [];
    const rows = await this.db
      .selectDistinct({ providerThreadId: oauthThreadTags.providerThreadId })
      .from(oauthThreadTags)
      .where(
        and(
          eq(oauthThreadTags.tenantId, tenantId),
          inArray(oauthThreadTags.tagId, tagIds as string[]),
        ),
      );
    return rows.map((r) => r.providerThreadId);
  }

  async countsByTag(tenantId: string): Promise<Map<string, number>> {
    const rows = await this.db.execute(sql`
      SELECT tag_id, count(*)::int AS n
      FROM oauth_thread_tags
      WHERE tenant_id = ${tenantId}
      GROUP BY tag_id
    `);
    const out = new Map<string, number>();
    for (const r of (rows.rows ?? []) as Array<{ tag_id: string; n: number }>) {
      out.set(r.tag_id, r.n);
    }
    return out;
  }
}
