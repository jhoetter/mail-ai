import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { mailRules } from "../schema.js";

export interface MailRuleRow {
  readonly id: string;
  readonly tenantId: string;
  readonly oauthAccountId: string;
  readonly name: string;
  readonly conditionsJson: unknown;
  readonly actionsJson: unknown;
  readonly enabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class MailRulesRepository {
  constructor(private readonly db: Database) {}

  async listByAccount(tenantId: string, oauthAccountId: string): Promise<MailRuleRow[]> {
    const rows = await this.db
      .select()
      .from(mailRules)
      .where(and(eq(mailRules.tenantId, tenantId), eq(mailRules.oauthAccountId, oauthAccountId)))
      .orderBy(desc(mailRules.createdAt));
    return rows as MailRuleRow[];
  }

  async create(row: {
    id: string;
    tenantId: string;
    oauthAccountId: string;
    name: string;
    conditionsJson: unknown;
    actionsJson: unknown;
    enabled?: boolean;
  }): Promise<void> {
    await this.db.insert(mailRules).values({
      id: row.id,
      tenantId: row.tenantId,
      oauthAccountId: row.oauthAccountId,
      name: row.name,
      conditionsJson: row.conditionsJson,
      actionsJson: row.actionsJson,
      enabled: row.enabled ?? true,
    });
  }

  async delete(tenantId: string, id: string): Promise<void> {
    await this.db
      .delete(mailRules)
      .where(and(eq(mailRules.tenantId, tenantId), eq(mailRules.id, id)));
  }
}
