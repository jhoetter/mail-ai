import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { tags, threadTags } from "../schema.js";

export interface TagRow {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly color: string;
}

// Default palette used when the caller doesn't pass a color. Picking
// from a small set keeps the UI cohesive and stops users from
// accidentally creating two near-identical greens.
const DEFAULT_COLORS = [
  "#ef4444", // red
  "#f59e0b", // amber
  "#eab308", // yellow
  "#10b981", // emerald
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#ec4899", // pink
] as const;

export class TagsRepository {
  constructor(private readonly db: Database) {}

  async upsert(row: TagRow): Promise<void> {
    await this.db
      .insert(tags)
      .values(row)
      .onConflictDoUpdate({ target: tags.id, set: { name: row.name, color: row.color } });
  }

  async listByTenant(tenantId: string): Promise<TagRow[]> {
    const rows = await this.db
      .select()
      .from(tags)
      .where(eq(tags.tenantId, tenantId))
      .orderBy(asc(tags.name));
    return rows as TagRow[];
  }

  async byName(tenantId: string, name: string): Promise<TagRow | null> {
    const rows = await this.db
      .select()
      .from(tags)
      .where(and(eq(tags.tenantId, tenantId), eq(tags.name, name)));
    return (rows[0] as TagRow | undefined) ?? null;
  }

  async byId(tenantId: string, id: string): Promise<TagRow | null> {
    const rows = await this.db
      .select()
      .from(tags)
      .where(and(eq(tags.tenantId, tenantId), eq(tags.id, id)));
    return (rows[0] as TagRow | undefined) ?? null;
  }

  async delete(tenantId: string, id: string): Promise<void> {
    await this.db.delete(tags).where(and(eq(tags.tenantId, tenantId), eq(tags.id, id)));
  }

  // Create-or-fetch helper: tags are mostly user-typed in a combobox,
  // and "add tag 'urgent'" should produce the same row whether it
  // exists yet or not. Color is auto-assigned when missing using a
  // deterministic hash on name so the same tag name lands on the
  // same color for everyone in the tenant.
  async ensureByName(tenantId: string, name: string, color?: string | null): Promise<TagRow> {
    const existing = await this.byName(tenantId, name);
    if (existing) return existing;
    const id = `tag_${tenantId}_${slugify(name)}_${shortHash(name)}`;
    const row: TagRow = {
      id,
      tenantId,
      name,
      color: color ?? colorFor(name),
    };
    await this.upsert(row);
    return row;
  }

  async addToThread(tenantId: string, threadId: string, tagId: string): Promise<void> {
    await this.db.insert(threadTags).values({ tenantId, threadId, tagId }).onConflictDoNothing();
  }

  async removeFromThread(tenantId: string, threadId: string, tagId: string): Promise<void> {
    await this.db
      .delete(threadTags)
      .where(
        and(
          eq(threadTags.tenantId, tenantId),
          eq(threadTags.threadId, threadId),
          eq(threadTags.tagId, tagId),
        ),
      );
  }
}

function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "tag"
  );
}

function shortHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36).slice(0, 6);
}

function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  return DEFAULT_COLORS[Math.abs(h) % DEFAULT_COLORS.length] as string;
}
