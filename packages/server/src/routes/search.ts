// GET /api/search — Postgres FTS over the OAuth message store.
//
// Lives here (not in oauth/routes.ts) because search is a tenant-wide
// read concern, not part of the OAuth onboarding flow. We compute the
// tsvector inline against `oauth_messages` rather than indexing a
// generated column; once corpus volume justifies it we add a GIN
// index in one migration without changing this surface.
//
// Response shape matches what apps/web's search page already expects:
//   { hits: [{ threadId, subject, snippet, rank }] }

import type { FastifyInstance } from "fastify";
import { searchOauthMessages, withTenant, type Pool } from "@mailai/overlay-db";

export interface SearchRoutesDeps {
  readonly pool: Pool;
  readonly identity: (req: { headers: Record<string, unknown> }) => Promise<{
    userId: string;
    tenantId: string;
  }>;
}

export function registerSearchRoutes(app: FastifyInstance, deps: SearchRoutesDeps): void {
  app.get("/api/search", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const q = (req.query as { q?: string; limit?: string }) ?? {};
    const query = (q.q ?? "").trim();
    if (query.length === 0) {
      return reply.code(400).send({ error: "validation_error", message: "missing q" });
    }
    const limit = q.limit ? Math.min(Math.max(Number(q.limit) || 50, 1), 200) : 50;

    const hits = await withTenant(deps.pool, ident.tenantId, (tx) =>
      searchOauthMessages(tx, { tenantId: ident.tenantId, q: query, limit }),
    );

    return {
      hits: hits.map((h) => ({
        // The UI clicks navigate to `/inbox/thread/<threadId>`; using
        // the row id keeps the link consistent with the inbox list,
        // which also keys on `oauth_messages.id` (provider thread id
        // collisions are rare but the row id is canonical).
        threadId: h.id,
        subject: h.subject ?? "(no subject)",
        snippet: h.snippet,
        rank: h.rank,
      })),
    };
  });
}
