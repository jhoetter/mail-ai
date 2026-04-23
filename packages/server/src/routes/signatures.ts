// GET /api/accounts/signatures
//
// Returns the per-account signature so the composer can prefill new
// drafts + replies + forwards. The mutation lives behind
// `account:set-signature` (handlers/account-signature.ts) so the read
// here is a plain query.

import type { FastifyInstance } from "fastify";
import { OauthAccountsRepository, withTenant, type Pool } from "@mailai/overlay-db";

export interface SignatureRoutesDeps {
  readonly pool: Pool;
  readonly identity: (req: { headers: Record<string, unknown> }) => Promise<{
    userId: string;
    tenantId: string;
  }>;
}

export function registerSignatureRoutes(app: FastifyInstance, deps: SignatureRoutesDeps): void {
  app.get("/api/accounts/signatures", async (req) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    return withTenant(deps.pool, ident.tenantId, async (tx) => {
      const repo = new OauthAccountsRepository(tx);
      const list = await repo.listByTenant(ident.tenantId);
      return {
        accounts: list.map((a) => ({
          id: a.id,
          email: a.email,
          provider: a.provider,
          signatureHtml: a.signatureHtml,
          signatureText: a.signatureText,
        })),
      };
    });
  });
}
