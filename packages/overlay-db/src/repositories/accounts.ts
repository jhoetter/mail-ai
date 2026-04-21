import { eq, and } from "drizzle-orm";
import type { Database } from "../client.js";
import { accounts } from "../schema.js";

export interface AccountRow {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly provider: string;
  readonly address: string;
  readonly imapHost: string;
  readonly imapPort: number;
  readonly smtpHost: string;
  readonly smtpPort: number;
  readonly credentialBlob: string;
}

export class AccountsRepository {
  constructor(private readonly db: Database) {}

  async byId(tenantId: string, id: string): Promise<AccountRow | null> {
    const rows = await this.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, id)));
    return (rows[0] as AccountRow | undefined) ?? null;
  }

  async listByTenant(tenantId: string): Promise<AccountRow[]> {
    const rows = await this.db.select().from(accounts).where(eq(accounts.tenantId, tenantId));
    return rows as AccountRow[];
  }

  async insert(row: AccountRow): Promise<void> {
    await this.db.insert(accounts).values(row);
  }
}
