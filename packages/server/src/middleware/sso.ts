import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const HANDOFF_QUERY_PARAM = "__hof_jwt";
const HANDOFF_CODE_QUERY_PARAM = "__hof_handoff";
const SESSION_COOKIE = "hof_subapp_session";
const DEV_FALLBACK_SECRET = "dev-only-not-for-prod-9c2f";
const EXPECTED_AUDIENCE = "mailai";

interface HandoffClaims {
  readonly aud?: string;
  readonly sub?: string;
  readonly tid?: string;
  readonly exp?: number;
}

function b64urlDecodeToBuffer(input: string): Buffer {
  const pad = "=".repeat((4 - (input.length % 4)) % 4);
  const b64 = (input + pad).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64");
}

function verifyHandoffJwt(token: string): HandoffClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const h = parts[0]!;
  const p = parts[1]!;
  const s = parts[2]!;

  const candidates: string[] = [];
  const env = (process.env["HOF_SUBAPP_JWT_SECRET"] ?? "").trim();
  if (env) candidates.push(env);
  const previous = (process.env["HOF_SUBAPP_JWT_SECRET_PREVIOUS"] ?? "").trim();
  if (previous) candidates.push(previous);
  if (!env) candidates.push(DEV_FALLBACK_SECRET);

  const provided = b64urlDecodeToBuffer(s);
  const matched = candidates.some((secret) => {
    const expected = createHmac("sha256", Buffer.from(secret, "utf-8"))
      .update(`${h}.${p}`)
      .digest();
    return expected.length === provided.length && timingSafeEqual(expected, provided);
  });
  if (!matched) return null;

  let claims: HandoffClaims;
  try {
    claims = JSON.parse(b64urlDecodeToBuffer(p).toString("utf-8")) as HandoffClaims;
  } catch {
    return null;
  }
  if (typeof claims.exp === "number" && claims.exp < Date.now() / 1000) return null;
  if (claims.aud !== EXPECTED_AUDIENCE) return null;
  if (!claims.sub || !claims.tid) return null;
  return claims;
}

interface HandoffExchangeResponse {
  readonly token?: string;
  readonly expires_at?: string;
  readonly audience?: string;
}

function maxAgeFromExpiry(exp: number | string | undefined): number {
  if (typeof exp === "number") {
    return Math.max(1, Math.floor(exp - Date.now() / 1000));
  }
  if (typeof exp === "string" && exp.length > 0) {
    return Math.max(1, Math.floor((Date.parse(exp) - Date.now()) / 1000));
  }
  return 120;
}

/** Set-Cookie header value for HttpOnly `hof_subapp_session`. Exported for `/api/auth/session-cookie`. */
export function buildMailaiSubappSessionCookie(token: string, maxAgeSeconds: number): string {
  const secure = process.env["HOF_ENV"] === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

function hofOsBaseUrl(): string {
  return (
    process.env["HOF_DATA_APP_PUBLIC_URL"] ||
    process.env["HOF_OS_PUBLIC_URL"] ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

async function exchangeHandoffCode(code: string): Promise<{ token: string; maxAgeSeconds: number } | null> {
  const res = await fetch(`${hofOsBaseUrl()}/api/subapp-handoff/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audience: EXPECTED_AUDIENCE, code }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as HandoffExchangeResponse;
  if (data.audience !== EXPECTED_AUDIENCE || typeof data.token !== "string") return null;
  const claims = verifyHandoffJwt(data.token);
  if (!claims) return null;
  return {
    token: data.token,
    maxAgeSeconds: Math.min(maxAgeFromExpiry(data.expires_at), maxAgeFromExpiry(claims.exp)),
  };
}

async function handleHandoff(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const url = new URL(request.url, "http://mailai.local");
  const code = url.searchParams.get(HANDOFF_CODE_QUERY_PARAM);
  const token = url.searchParams.get(HANDOFF_QUERY_PARAM);
  if (!code && !token) return;
  url.searchParams.delete(HANDOFF_CODE_QUERY_PARAM);
  url.searchParams.delete(HANDOFF_QUERY_PARAM);
  const cleanPath = `${url.pathname || "/"}${url.search}${url.hash}`;
  if (code) {
    const exchanged = await exchangeHandoffCode(code);
    if (exchanged) {
      reply.header("set-cookie", buildMailaiSubappSessionCookie(exchanged.token, exchanged.maxAgeSeconds));
    }
    reply.redirect(cleanPath || "/");
    return;
  }
  if (!token) return;
  // Verify the handoff JWT before promoting it to a host-scoped session
  // cookie. If it fails (bad signature, wrong audience, expired) we still
  // strip it from the URL and redirect to the clean path so the user does
  // not see a never-clearing token in their address bar; the next
  // protected request will be challenged by `buildHofJwtIdentity`.
  const claims = verifyHandoffJwt(token);
  if (claims) {
    reply.header("set-cookie", buildMailaiSubappSessionCookie(token, maxAgeFromExpiry(claims.exp)));
  }
  reply.redirect(cleanPath || "/");
}

export function registerSsoMiddleware(app: FastifyInstance): void {
  app.post("/api/subapp-handoff/exchange", async (request, reply) => {
    const body = request.body as { code?: unknown; audience?: unknown } | undefined;
    const code = typeof body?.code === "string" ? body.code : "";
    const audience = typeof body?.audience === "string" ? body.audience : "";
    if (audience !== EXPECTED_AUDIENCE || !code) {
      reply.code(400).send({ error: "audience and code are required" });
      return;
    }
    const exchanged = await exchangeHandoffCode(code);
    if (!exchanged) {
      reply.code(401).send({ error: "invalid or expired handoff code" });
      return;
    }
    reply
      .header("set-cookie", buildMailaiSubappSessionCookie(exchanged.token, exchanged.maxAgeSeconds))
      .send({ ok: true });
  });
  app.addHook("onRequest", handleHandoff);
}

export const __testInternals = {
  verifyHandoffJwt,
  buildMailaiSubappSessionCookie,
  exchangeHandoffCode,
  maxAgeFromExpiry,
};
