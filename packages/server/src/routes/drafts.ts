// Drafts list/get routes. Mutations (create / update / delete / send)
// route through the CommandBus via /api/commands so the audit log
// captures every change. We expose direct list/get because they're
// pure reads and the UI needs them frequently.

import type { FastifyInstance } from "fastify";
import { DraftsRepository, withTenant, type Pool } from "@mailai/overlay-db";

export interface DraftRoutesDeps {
  readonly pool: Pool;
  readonly identity: (req: { headers: Record<string, unknown> }) => Promise<{
    userId: string;
    tenantId: string;
  }>;
}

export function registerDraftRoutes(app: FastifyInstance, deps: DraftRoutesDeps): void {
  app.get("/api/drafts", async (req) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    return withTenant(deps.pool, ident.tenantId, async (tx) => {
      const repo = new DraftsRepository(tx);
      const list = await repo.listByUser(ident.tenantId, ident.userId);
      return {
        drafts: list.map((d) => ({
          id: d.id,
          to: d.toAddr,
          cc: d.ccAddr,
          bcc: d.bccAddr,
          subject: d.subject,
          bodyText: d.bodyText,
          bodyHtml: d.bodyHtml,
          providerThreadId: d.providerThreadId,
          replyToMessageId: d.replyToMessageId,
          updatedAt: d.updatedAt.toISOString(),
        })),
      };
    });
  });

  app.get("/api/drafts/:id", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const { id } = req.params as { id: string };
    return withTenant(deps.pool, ident.tenantId, async (tx) => {
      const repo = new DraftsRepository(tx);
      const row = await repo.byId(ident.tenantId, ident.userId, id);
      if (!row) {
        return reply.code(404).send({ error: "not_found", message: `draft ${id} not found` });
      }
      return {
        draft: {
          id: row.id,
          to: row.toAddr,
          cc: row.ccAddr,
          bcc: row.bccAddr,
          subject: row.subject,
          bodyText: row.bodyText,
          bodyHtml: row.bodyHtml,
          providerThreadId: row.providerThreadId,
          replyToMessageId: row.replyToMessageId,
          updatedAt: row.updatedAt.toISOString(),
        },
      };
    });
  });
}
