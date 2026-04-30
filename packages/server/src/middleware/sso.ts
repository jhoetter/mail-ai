import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const HANDOFF_QUERY_PARAM = "__hof_jwt";
const SESSION_COOKIE = "hof_subapp_session";

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
  reply.header("set-cookie", cookieHeader(token));
  reply.redirect(cleanPath || "/");
}

export function registerSsoMiddleware(app: FastifyInstance): void {
  app.addHook("onRequest", handleHandoff);
}
