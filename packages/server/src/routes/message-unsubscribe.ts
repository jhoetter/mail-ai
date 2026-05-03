import type { FastifyInstance } from "fastify";
import { OauthMessagesRepository, withTenant, type Pool } from "@mailai/overlay-db";

export interface MessageUnsubscribeDeps {
  readonly pool: Pool;
  readonly identity: (req: { headers: Record<string, unknown> }) => Promise<{
    userId: string;
    tenantId: string;
  }>;
}

function parseAngleUrls(raw: string): string[] {
  const out: string[] = [];
  const re = /<([^>\s]+)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    out.push(m[1]!.trim());
  }
  return out;
}

function pickHttpsFirst(urls: string[]): string | null {
  for (const u of urls) {
    if (u.toLowerCase().startsWith("https://")) return u;
  }
  return null;
}

function pickMailtoFirst(urls: string[]): string | null {
  for (const u of urls) {
    if (u.toLowerCase().startsWith("mailto:")) return u;
  }
  return null;
}

export function registerMessageUnsubscribeRoutes(app: FastifyInstance, deps: MessageUnsubscribeDeps) {
  app.post("/api/messages/:id/unsubscribe", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const { id } = req.params as { id: string };
    const row = await withTenant(deps.pool, ident.tenantId, async (tx) => {
      const repo = new OauthMessagesRepository(tx);
      return repo.byId(ident.tenantId, id);
    });
    if (!row) {
      return reply.code(404).send({ error: "not_found", message: `message ${id} not found` });
    }
    const header = row.listUnsubscribe;
    if (!header || header.trim().length === 0) {
      return reply
        .code(400)
        .send({ error: "validation_error", message: "no List-Unsubscribe on message" });
    }
    const urls = parseAngleUrls(header);
    const httpsUrl = pickHttpsFirst(urls);
    const postSpec = (row.listUnsubscribePost ?? "").trim();
    const wantsOneClick = postSpec.toLowerCase().includes("list-unsubscribe=one-click");

    if (wantsOneClick && httpsUrl) {
      try {
        const r = await fetch(httpsUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            // RFC 8058
            "List-Unsubscribe": "One-Click",
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
          body: "List-Unsubscribe=One-Click",
        });
        if (!r.ok) {
          const t = await r.text().catch(() => "");
          return reply.code(502).send({
            error: "upstream_error",
            message: `unsubscribe POST failed: ${r.status} ${t.slice(0, 120)}`,
          });
        }
        return { ok: true, mode: "one_click" as const };
      } catch (err) {
        return reply.code(502).send({
          error: "upstream_error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const mailto = pickMailtoFirst(urls);
    if (mailto) {
      return { ok: true, mode: "mailto" as const, href: mailto };
    }

    if (httpsUrl) {
      return { ok: true, mode: "open" as const, href: httpsUrl };
    }

    return reply.code(400).send({
      error: "validation_error",
      message: "could not parse List-Unsubscribe target",
    });
  });
}
