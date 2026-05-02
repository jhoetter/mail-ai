// POST /api/auth/session-cookie — mirror the active Bearer JWT into the
// HttpOnly `hof_subapp_session` cookie so <img src=/api/attachments/.../inline>
// loads work: image requests cannot send Authorization headers, but they do
// attach same-site cookies (see buildHofJwtIdentity in auth/hof-jwt.ts).

import type { FastifyInstance } from "fastify";
import { buildMailaiSubappSessionCookie } from "../middleware/sso.js";

export interface SessionCookieRouteDeps {
  readonly identity: (req: { headers: Record<string, unknown> }) => Promise<unknown>;
}

function extractBearer(headers: Record<string, unknown>): string | null {
  const raw = headers["authorization"] ?? headers["Authorization"];
  if (typeof raw !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw);
  return m?.[1]?.trim() ?? null;
}

function maxAgeSecondsFromJwtExp(token: string): number {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return 3600;
    const padded = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const pad = "=".repeat((4 - (padded.length % 4)) % 4);
    const json = Buffer.from(padded + pad, "base64").toString("utf-8");
    const payload = JSON.parse(json) as { exp?: number };
    if (typeof payload.exp !== "number") return 3600;
    const left = Math.floor(payload.exp - Date.now() / 1000);
    return Math.min(86400, Math.max(120, left));
  } catch {
    return 3600;
  }
}

export function registerSessionCookieRoute(app: FastifyInstance, deps: SessionCookieRouteDeps): void {
  app.post("/api/auth/session-cookie", async (req, reply) => {
    const secretEnv = (process.env["HOF_SUBAPP_JWT_SECRET"] ?? "").trim();
    if (!secretEnv) {
      // Local `make dev`: identity does not require JWT; <img> inline
      // already hits the stub resolver without a cookie.
      return reply.code(204).send();
    }
    await deps.identity({ headers: req.headers as Record<string, unknown> });
    const bearer = extractBearer(req.headers as Record<string, unknown>);
    if (!bearer) {
      // Cookie-only auth (SSO redirect) — inline images already authenticate.
      return reply.code(204).send();
    }
    const maxAge = maxAgeSecondsFromJwtExp(bearer);
    return reply
      .header("Set-Cookie", buildMailaiSubappSessionCookie(bearer, maxAge))
      .code(204)
      .send();
  });
}
