import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import {
  MailRulesRepository,
  OauthAccountsRepository,
  withTenant,
  type Pool,
} from "@mailai/overlay-db";

export interface MailRulesRoutesDeps {
  readonly pool: Pool;
  readonly identity: (req: { headers: Record<string, unknown> }) => Promise<{
    userId: string;
    tenantId: string;
  }>;
}

export function registerMailRulesRoutes(app: FastifyInstance, deps: MailRulesRoutesDeps): void {
  app.get("/api/mail-rules", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const accountId = (req.query as { accountId?: string }).accountId;
    if (!accountId || accountId.length === 0) {
      return reply.code(400).send({ error: "validation_error", message: "accountId required" });
    }
    const result = await withTenant(deps.pool, ident.tenantId, async (tx) => {
      const accounts = new OauthAccountsRepository(tx);
      const acct = await accounts.byId(ident.tenantId, accountId);
      if (!acct) return { error: "not_found" as const };
      const repo = new MailRulesRepository(tx);
      const rules = await repo.listByAccount(ident.tenantId, accountId);
      return { error: null, rules } as const;
    });
    if (result.error) {
      return reply.code(404).send({ error: "not_found", message: "account not found" });
    }
    return { rules: result.rules };
  });

  app.post("/api/mail-rules", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const body = req.body as
      | {
          accountId?: unknown;
          name?: unknown;
          conditions?: unknown;
          actions?: unknown;
          enabled?: unknown;
        }
      | undefined;
    if (!body) {
      return reply.code(400).send({ error: "validation_error", message: "body required" });
    }
    const accountId = body.accountId;
    const ruleName = body.name;
    if (typeof accountId !== "string" || typeof ruleName !== "string") {
      return reply
        .code(400)
        .send({ error: "validation_error", message: "accountId+name required" });
    }
    const created = await withTenant(deps.pool, ident.tenantId, async (tx) => {
      const accounts = new OauthAccountsRepository(tx);
      const acct = await accounts.byId(ident.tenantId, accountId);
      if (!acct) return { error: "not_found" as const };
      const repo = new MailRulesRepository(tx);
      const id = `mr_${randomUUID()}`;
      await repo.create({
        id,
        tenantId: ident.tenantId,
        oauthAccountId: accountId,
        name: ruleName.trim(),
        conditionsJson: body.conditions ?? {},
        actionsJson: body.actions ?? {},
        enabled: body.enabled === false ? false : true,
      });
      return { error: null, id } as const;
    });
    if (created.error) {
      return reply.code(404).send({ error: "not_found", message: "account not found" });
    }
    return { id: created.id };
  });

  app.delete("/api/mail-rules/:id", async (req, _reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const { id } = req.params as { id: string };
    await withTenant(deps.pool, ident.tenantId, async (tx) => {
      const repo = new MailRulesRepository(tx);
      await repo.delete(ident.tenantId, id);
    });
    return { ok: true };
  });
}
