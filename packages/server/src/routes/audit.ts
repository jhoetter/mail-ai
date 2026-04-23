// GET /api/audit — read-only paginated view over the audit_log.
//
// Filters: actor, type, threadId, since, until.
// Pagination: opaque `cursor` string (the seq of the last row).
// Response: { items: AuditRow[], nextCursor: string | null }.
//
// Authority pattern: the audit log is the durable copy of every
// mutation. We never mutate it from the API — append-only via the
// CommandBus' AuditSink. This route only reads.

import type { FastifyInstance } from "fastify";
import { AuditRepository, withTenant, type Pool } from "@mailai/overlay-db";

export interface AuditRoutesDeps {
  readonly pool: Pool;
  readonly identity: (req: { headers: Record<string, unknown> }) => Promise<{
    userId: string;
    tenantId: string;
  }>;
}

export function registerAuditRoutes(app: FastifyInstance, deps: AuditRoutesDeps): void {
  app.get("/api/audit", async (req) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const q =
      (req.query as {
        actor?: string;
        type?: string;
        threadId?: string;
        since?: string;
        until?: string;
        cursor?: string;
        limit?: string;
      }) ?? {};

    const limit = q.limit ? Math.min(Math.max(Number(q.limit) || 50, 1), 200) : 50;

    const since = q.since ? parseDateOrRelative(q.since) : null;
    const until = q.until ? parseDateOrRelative(q.until) : null;
    let cursor: bigint | undefined;
    if (q.cursor) {
      try {
        cursor = BigInt(q.cursor);
      } catch {
        // Bad cursor is a soft error — return page 1 instead of
        // failing. The client gets a fresh nextCursor anyway.
      }
    }
    const filter: Parameters<AuditRepository["list"]>[0] = {
      tenantId: ident.tenantId,
      limit,
      ...(q.actor ? { actor: q.actor } : {}),
      ...(q.type ? { type: q.type } : {}),
      ...(q.threadId ? { threadId: q.threadId } : {}),
      ...(since ? { since } : {}),
      ...(until ? { until } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    };

    const page = await withTenant(deps.pool, ident.tenantId, (tx) => {
      const repo = new AuditRepository(tx);
      return repo.list(filter);
    });

    return {
      items: page.items.map((r) => ({
        seq: String(r.seq),
        mutationId: r.mutationId,
        commandType: r.commandType,
        actorId: r.actorId,
        source: r.source,
        status: r.status,
        payload: r.payloadJson,
        diff: r.diffJson,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  });
}

// Accepts ISO timestamps or relative shorthands like "1h", "24h", "7d".
function parseDateOrRelative(s: string): Date | null {
  const rel = s.match(/^(\d+)(s|m|h|d)$/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2] as "s" | "m" | "h" | "d";
    const ms =
      n * (unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
    return new Date(Date.now() - ms);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
