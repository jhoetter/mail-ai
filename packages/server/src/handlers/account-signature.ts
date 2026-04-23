// Persist a per-account email signature edited via Settings.
// Composer + InlineReply prepend the signature on new drafts +
// replies + forwards (see mail-send.ts/applySignature).

import type { CommandHandler, HandlerContext, HandlerResult } from "@mailai/core";
import { MailaiError } from "@mailai/core";
import { OauthAccountsRepository, withTenant, type Pool } from "@mailai/overlay-db";

export interface SignatureDeps {
  readonly pool: Pool;
  readonly tenantId: string;
}

interface SetSignaturePayload {
  accountId: string;
  signatureHtml: string | null;
  signatureText: string | null;
}

export function buildAccountSetSignatureHandler(
  deps: SignatureDeps,
): CommandHandler<"account:set-signature", SetSignaturePayload> {
  return async (
    cmd: { payload: SetSignaturePayload },
    _ctx: HandlerContext,
  ): Promise<HandlerResult> => {
    const payload = cmd.payload;
    const updated = await withTenant(deps.pool, deps.tenantId, async (tx) => {
      const repo = new OauthAccountsRepository(tx);
      const existing = await repo.byId(deps.tenantId, payload.accountId);
      if (!existing) {
        throw new MailaiError("not_found", `account ${payload.accountId} not found`);
      }
      await repo.setSignature(deps.tenantId, payload.accountId, {
        html: payload.signatureHtml,
        text: payload.signatureText,
      });
      return repo.byId(deps.tenantId, payload.accountId);
    });
    return {
      before: [
        {
          kind: "oauth-account",
          id: payload.accountId,
          version: 1,
          data: {},
        },
      ],
      after: [
        {
          kind: "oauth-account",
          id: payload.accountId,
          version: 2,
          data: {
            signatureHtml: updated?.signatureHtml ?? null,
            signatureText: updated?.signatureText ?? null,
          },
        },
      ],
      imapSideEffects: [],
    };
  };
}
