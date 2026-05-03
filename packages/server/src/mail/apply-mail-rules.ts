import type { OauthAccountRow, OauthMessageInsert, OauthMessageRow } from "@mailai/overlay-db";
import {
  MailRulesRepository,
  OauthMessagesRepository,
  withTenant,
  type Pool,
} from "@mailai/overlay-db";

export interface MailRuleConditions {
  readonly fromContains?: string;
  readonly subjectRegex?: string;
  readonly hasAttachment?: boolean;
}

export interface MailRuleActions {
  readonly markImportant?: boolean;
  readonly markRead?: boolean;
}

/**
 * Best-effort rules pass on freshly upserted messages. Runs after the
 * sync transaction commits so rows are visible to a new connection.
 */
export async function applyMailRulesForBatch(
  pool: Pool,
  tenantId: string,
  account: OauthAccountRow,
  rows: readonly OauthMessageInsert[],
): Promise<void> {
  if (rows.length === 0) return;
  await withTenant(pool, tenantId, async (tx) => {
    const rulesRepo = new MailRulesRepository(tx);
    const msgRepo = new OauthMessagesRepository(tx);
    const rules = await rulesRepo.listByAccount(tenantId, account.id);
    const enabled = rules.filter((r) => r.enabled);
    if (enabled.length === 0) return;
    for (const ins of rows) {
      const row = await msgRepo.byProviderMessage(tenantId, account.id, ins.providerMessageId);
      if (!row) continue;
      for (const rule of enabled) {
        const cond = rule.conditionsJson as MailRuleConditions;
        const act = rule.actionsJson as MailRuleActions;
        if (!matches(cond, row)) continue;
        if (act.markImportant) {
          await msgRepo.setImportantByProvider(tenantId, account.id, row.providerMessageId, true);
        }
        if (act.markRead) {
          await msgRepo.setUnreadByThread(tenantId, row.providerThreadId, false);
        }
      }
    }
  });
}

function matches(c: MailRuleConditions, row: OauthMessageRow): boolean {
  if (c.fromContains) {
    const needle = c.fromContains.toLowerCase();
    const blob = `${row.fromEmail ?? ""} ${row.fromName ?? ""}`.toLowerCase();
    if (!blob.includes(needle)) return false;
  }
  if (c.subjectRegex) {
    try {
      if (!new RegExp(c.subjectRegex, "i").test(row.subject ?? "")) return false;
    } catch {
      return false;
    }
  }
  if (c.hasAttachment === true && !row.hasAttachments) return false;
  return true;
}

/** Collect `onBatchUpserted` events during sync, then `flush` after the DB tx commits. */
export function createMailRulesBatchCollector(): {
  onBatchUpserted: (account: OauthAccountRow, rows: readonly OauthMessageInsert[]) => void;
  flush: (pool: Pool, tenantId: string) => Promise<void>;
} {
  const pending: { account: OauthAccountRow; rows: OauthMessageInsert[] }[] = [];
  return {
    onBatchUpserted(account, rows) {
      pending.push({ account, rows: [...rows] });
    },
    async flush(pool, tenantId) {
      for (const p of pending) {
        try {
          await applyMailRulesForBatch(pool, tenantId, p.account, p.rows);
        } catch (err) {
          console.warn("[mail-rules] apply failed", err);
        }
      }
    },
  };
}
