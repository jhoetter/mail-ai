// GET /api/search — multiplexed global search backing the top bar.
//
// One request, six result categories (messages / files / people /
// mailboxes / tags / calendar). The repository layer
// (`searchAll` in @mailai/overlay-db) does the fan-out; this file
// just owns the HTTP contract: parse query params, run inside a
// tenant-scoped transaction, and shape the JSON the front-end
// expects.
//
// Query params:
//   q              free-text query (optional when chips are set)
//   accountId      restrict to an oauth_accounts.id ("Postfach")
//   fromEmail      substring match against from_email
//   toEmail        substring match against to_addr
//   tag            tag name (case-insensitive)
//   hasAttachment  "1" | "true" toggle
//   hasLink        "1" | "true" toggle
//   limit          per-domain row cap override (1–50)

import type { FastifyInstance } from "fastify";
import { searchAll, withTenant, type Pool } from "@mailai/overlay-db";

export interface SearchRoutesDeps {
  readonly pool: Pool;
  readonly identity: (req: { headers: Record<string, unknown> }) => Promise<{
    userId: string;
    tenantId: string;
  }>;
}

function asBool(v: unknown): boolean {
  if (typeof v !== "string") return false;
  return v === "1" || v.toLowerCase() === "true";
}

export function registerSearchRoutes(app: FastifyInstance, deps: SearchRoutesDeps): void {
  app.get("/api/search", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const params = (req.query as Record<string, string | undefined>) ?? {};

    const q = (params.q ?? "").trim();
    const accountId = params.accountId?.trim() || undefined;
    const fromEmail = params.fromEmail?.trim() || undefined;
    const toEmail = params.toEmail?.trim() || undefined;
    const tag = params.tag?.trim() || undefined;
    const hasAttachment = asBool(params.hasAttachment);
    const hasLink = asBool(params.hasLink);

    const hasAnyFilter =
      q.length > 0 ||
      Boolean(accountId) ||
      Boolean(fromEmail) ||
      Boolean(toEmail) ||
      Boolean(tag) ||
      hasAttachment ||
      hasLink;
    if (!hasAnyFilter) {
      // The empty-input case never hits Postgres — it returns the
      // canonical empty payload so the client can always treat the
      // shape as exhaustive.
      return reply.send({
        messages: [],
        files: [],
        people: [],
        mailboxes: [],
        tags: [],
        calendar: [],
      });
    }

    // Optional uniform per-domain cap. The repository defaults are
    // tuned per category; this just lets a caller force-clip them
    // (e.g. for embeds) without exposing six distinct knobs.
    const limit = params.limit ? Math.min(Math.max(Number(params.limit) || 0, 1), 50) : undefined;
    const limits = limit
      ? {
          messages: limit,
          files: limit,
          people: limit,
          mailboxes: limit,
          tags: limit,
          calendar: limit,
        }
      : undefined;

    const result = await withTenant(deps.pool, ident.tenantId, (tx) =>
      searchAll(tx, {
        tenantId: ident.tenantId,
        q,
        ...(accountId ? { accountId } : {}),
        ...(fromEmail ? { fromEmail } : {}),
        ...(toEmail ? { toEmail } : {}),
        ...(tag ? { tag } : {}),
        ...(hasAttachment ? { hasAttachment: true } : {}),
        ...(hasLink ? { hasLink: true } : {}),
        ...(limits ? { limits } : {}),
      }),
    );

    return reply.send(result);
  });
}
