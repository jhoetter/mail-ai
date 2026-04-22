// Tag CRUD + per-thread tag listing.
//
// Mutations route through the CommandBus (POST tag-on-thread is a
// thread:add-tag command). Tag definition CRUD (create, rename,
// delete) is rare enough that we keep it as direct repo writes for
// now — they're admin-shaped operations the user does once per tag.
// If we ever need an audit trail for tag definitions we'll graduate
// them to commands too.

import type { FastifyInstance } from "fastify";
import {
  OauthMessagesRepository,
  OauthThreadTagsRepository,
  TagsRepository,
  withTenant,
  type Pool,
} from "@mailai/overlay-db";

export interface TagRoutesDeps {
  readonly pool: Pool;
  readonly identity: (req: { headers: Record<string, unknown> }) => Promise<{
    userId: string;
    tenantId: string;
  }>;
}

export function registerTagRoutes(app: FastifyInstance, deps: TagRoutesDeps): void {
  app.get("/api/tags", async (req) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    return withTenant(deps.pool, ident.tenantId, async (tx) => {
      const repo = new OauthThreadTagsRepository(tx);
      const tagsRepo = new TagsRepository(tx);
      const list = await tagsRepo.listByTenant(ident.tenantId);
      const counts = await repo.countsByTag(ident.tenantId);
      return {
        tags: list.map((t) => ({
          id: t.id,
          name: t.name,
          color: t.color,
          count: counts.get(t.id) ?? 0,
        })),
      };
    });
  });

  app.post("/api/tags", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const body = req.body as { name?: unknown; color?: unknown } | undefined;
    if (!body || typeof body.name !== "string" || body.name.trim().length === 0) {
      return reply.code(400).send({ error: "validation_error", message: "name required" });
    }
    const color = typeof body.color === "string" ? body.color : null;
    return withTenant(deps.pool, ident.tenantId, async (tx) => {
      const repo = new TagsRepository(tx);
      const row = await repo.ensureByName(ident.tenantId, body.name as string, color);
      return { tag: { id: row.id, name: row.name, color: row.color } };
    });
  });

  app.delete("/api/tags/:id", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const { id } = req.params as { id: string };
    return withTenant(deps.pool, ident.tenantId, async (tx) => {
      const repo = new TagsRepository(tx);
      const existing = await repo.byId(ident.tenantId, id);
      if (!existing) {
        return reply.code(404).send({ error: "not_found", message: `tag ${id} not found` });
      }
      await repo.delete(ident.tenantId, id);
      return { ok: true };
    });
  });

  // Tags currently applied to a thread, addressed by oauth_messages.id
  // (the URL-safe row identifier the inbox already passes around).
  app.get("/api/threads/:id/tags", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const { id } = req.params as { id: string };
    return withTenant(deps.pool, ident.tenantId, async (tx) => {
      const messages = new OauthMessagesRepository(tx);
      const root = await messages.byId(ident.tenantId, id);
      if (!root) {
        return reply.code(404).send({ error: "not_found", message: `thread ${id} not found` });
      }
      const repo = new OauthThreadTagsRepository(tx);
      const list = await repo.listForThread(ident.tenantId, root.providerThreadId);
      return {
        providerThreadId: root.providerThreadId,
        tags: list.map((t) => ({ id: t.id, name: t.name, color: t.color })),
      };
    });
  });
}
