import type { CommandHandler, EntitySnapshot, HandlerResult } from "@mailai/core";
import { MailaiError } from "@mailai/core";
import { OauthAccountsRepository, withTenant, type Pool } from "@mailai/overlay-db";

export interface AccountVacationDeps {
  readonly pool: Pool;
  readonly tenantId: string;
}

interface VacationPayload {
  accountId: string;
  enabled: boolean;
  subject?: string | null;
  message?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
}

export function buildAccountSetVacationHandler(
  base: AccountVacationDeps,
): CommandHandler<"account:set-vacation", VacationPayload> {
  return async (cmd, hx) => {
    const deps = { ...base, tenantId: hx.tenantId ?? base.tenantId };
    const p = cmd.payload;
    await withTenant(deps.pool, deps.tenantId, async (tx) => {
      const repo = new OauthAccountsRepository(tx);
      const acct = await repo.byId(deps.tenantId, p.accountId);
      if (!acct) {
        throw new MailaiError("not_found", `account ${p.accountId} not found`);
      }
      const startsAt = p.startsAt ? new Date(p.startsAt) : null;
      const endsAt = p.endsAt ? new Date(p.endsAt) : null;
      if (startsAt && Number.isNaN(startsAt.getTime())) {
        throw new MailaiError("validation_error", "invalid startsAt");
      }
      if (endsAt && Number.isNaN(endsAt.getTime())) {
        throw new MailaiError("validation_error", "invalid endsAt");
      }
      await repo.setVacation(deps.tenantId, p.accountId, {
        enabled: p.enabled,
        subject: p.subject === undefined ? null : p.subject,
        message: p.message === undefined ? null : p.message,
        startsAt,
        endsAt,
      });
    });
    const snapshot: EntitySnapshot = {
      kind: "account",
      id: p.accountId,
      version: 1,
      data: { vacationEnabled: p.enabled },
    };
    const out: HandlerResult = {
      before: [{ kind: "account", id: p.accountId, version: 0, data: {} }],
      after: [snapshot],
      imapSideEffects: [],
    };
    return out;
  };
}
