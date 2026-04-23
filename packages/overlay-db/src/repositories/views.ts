// Views repository.
//
// Each row is a saved query (filter + sort + group) per user. The
// built-in defaults (Inbox / Drafts / Sent / Snoozed / Done / Trash
// / Spam) are seeded by `ensureBuiltinsForUser` on first read so a
// new user lands on a populated sidebar.
//
// filter_json is opaque to the repo — the views route compiles it
// into a SQL predicate. Keeping the schema flexible (jsonb) means
// we can add new predicate kinds without a migration.

import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { views } from "../schema.js";

export interface ViewFilter {
  // OAuth-side selectors. Empty arrays are ignored; absent keys
  // disable the predicate.
  readonly tagsAny?: readonly string[];
  readonly tagsNone?: readonly string[];
  readonly status?: ReadonlyArray<"open" | "snoozed" | "done">;
  readonly fromContains?: string;
  readonly unread?: boolean;
  readonly accountIds?: readonly string[];
  // Semantic view kinds. "drafts" pulls from its own table; the
  // others are filtered by oauth_messages.well_known_folder so the
  // views compiler never has to look inside provider labels.
  readonly kind?: "default" | "drafts" | "sent" | "trash" | "spam" | "all";
}

export interface ViewRow {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly name: string;
  readonly icon: string | null;
  readonly position: number;
  readonly isBuiltin: boolean;
  readonly filterJson: ViewFilter;
  readonly sortBy: string;
  readonly groupBy: string | null;
  readonly layout: string;
  readonly createdAt: Date;
}

export interface ViewInsert {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly name: string;
  readonly icon?: string | null;
  readonly position: number;
  readonly isBuiltin?: boolean;
  readonly filterJson: ViewFilter;
  readonly sortBy?: string;
  readonly groupBy?: string | null;
  readonly layout?: string;
}

const BUILTINS: ReadonlyArray<{
  suffix: string;
  name: string;
  icon: string;
  filter: ViewFilter;
  position: number;
}> = [
  {
    suffix: "inbox",
    name: "Inbox",
    icon: "📥",
    position: 0,
    filter: { kind: "default", status: ["open"] },
  },
  { suffix: "drafts", name: "Drafts", icon: "✏️", position: 1, filter: { kind: "drafts" } },
  { suffix: "sent", name: "Sent", icon: "📤", position: 2, filter: { kind: "sent" } },
  {
    suffix: "snoozed",
    name: "Snoozed",
    icon: "💤",
    position: 3,
    filter: { kind: "default", status: ["snoozed"] },
  },
  {
    suffix: "done",
    name: "Done",
    icon: "✓",
    position: 4,
    filter: { kind: "default", status: ["done"] },
  },
  { suffix: "trash", name: "Trash", icon: "🗑️", position: 5, filter: { kind: "trash" } },
  { suffix: "spam", name: "Spam", icon: "🚫", position: 6, filter: { kind: "spam" } },
];

export class ViewsRepository {
  constructor(private readonly db: Database) {}

  async list(tenantId: string, userId: string): Promise<ViewRow[]> {
    const rows = await this.db
      .select()
      .from(views)
      .where(and(eq(views.tenantId, tenantId), eq(views.userId, userId)))
      .orderBy(asc(views.position));
    return rows as ViewRow[];
  }

  async byId(tenantId: string, userId: string, id: string): Promise<ViewRow | null> {
    const rows = await this.db
      .select()
      .from(views)
      .where(and(eq(views.tenantId, tenantId), eq(views.userId, userId), eq(views.id, id)));
    return (rows[0] as ViewRow | undefined) ?? null;
  }

  async upsert(row: ViewInsert): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO views (
        id, tenant_id, user_id, name, icon, position, is_builtin,
        filter_json, sort_by, group_by, layout
      ) VALUES (
        ${row.id}, ${row.tenantId}, ${row.userId}, ${row.name},
        ${row.icon ?? null}, ${row.position}, ${row.isBuiltin ?? false},
        ${JSON.stringify(row.filterJson)}::jsonb,
        ${row.sortBy ?? "date_desc"}, ${row.groupBy ?? null},
        ${row.layout ?? "list"}
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        icon = EXCLUDED.icon,
        position = EXCLUDED.position,
        filter_json = EXCLUDED.filter_json,
        sort_by = EXCLUDED.sort_by,
        group_by = EXCLUDED.group_by,
        layout = EXCLUDED.layout
    `);
  }

  async delete(tenantId: string, userId: string, id: string): Promise<void> {
    await this.db
      .delete(views)
      .where(and(eq(views.tenantId, tenantId), eq(views.userId, userId), eq(views.id, id)));
  }

  // Seed the built-in defaults for a user on first read. Idempotent
  // via stable view ids derived from (userId, suffix).
  async ensureBuiltinsForUser(tenantId: string, userId: string): Promise<ViewRow[]> {
    const existing = await this.list(tenantId, userId);
    const existingIds = new Set(existing.map((v) => v.id));
    for (const def of BUILTINS) {
      const id = `view_${userId}_${def.suffix}`;
      if (existingIds.has(id)) continue;
      await this.upsert({
        id,
        tenantId,
        userId,
        name: def.name,
        icon: def.icon,
        position: def.position,
        isBuiltin: true,
        filterJson: def.filter,
      });
    }
    return this.list(tenantId, userId);
  }
}
