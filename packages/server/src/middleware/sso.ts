import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const HANDOFF_QUERY_PARAM = "__hof_jwt";
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

function cookieHeader(token: string): string {
  const secure = process.env["HOF_ENV"] === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${secure}`;
}

async function handleHandoff(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const url = new URL(request.url, "http://mailai.local");
  const token = url.searchParams.get(HANDOFF_QUERY_PARAM);
  if (!token) return;
  url.searchParams.delete(HANDOFF_QUERY_PARAM);
  const cleanPath = `${url.pathname || "/"}${url.search}${url.hash}`;
  // Verify the handoff JWT before promoting it to a host-scoped session
  // cookie. If it fails (bad signature, wrong audience, expired) we still
  // strip it from the URL and redirect to the clean path so the user does
  // not see a never-clearing token in their address bar; the next
  // protected request will be challenged by `buildHofJwtIdentity`.
  const claims = verifyHandoffJwt(token);
  if (claims) {
    reply.header("set-cookie", cookieHeader(token));
  }
  reply.redirect(cleanPath || "/");
}

export function registerSsoMiddleware(app: FastifyInstance): void {
  app.addHook("onRequest", handleHandoff);
}

export const __testInternals = {
  verifyHandoffJwt,
  cookieHeader,
};
