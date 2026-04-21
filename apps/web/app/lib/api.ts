// Thin client wrapper used by the apps/web Next pages. The real
// transport lives in @mailai/agent's HttpAgentClient; this module
// just adapts request defaults (base URL, token resolution) to the
// host environment. Same JSON contract end-to-end.

import { HttpAgentClient } from "@mailai/agent";

export function baseUrl(): string {
  // Empty string → relative URLs hit the Next dev server, which is
  // configured (next.config.ts) to rewrite /api/* to the actual API
  // origin. Override with NEXT_PUBLIC_MAILAI_API_URL when the web app
  // is served from a different origin than the API in production.
  return process.env["NEXT_PUBLIC_MAILAI_API_URL"] ?? "";
}

function token(): string {
  if (typeof window === "undefined") return process.env["MAILAI_TOKEN"] ?? "";
  return window.localStorage.getItem("mailai.token") ?? "";
}

export function client(): HttpAgentClient {
  return new HttpAgentClient({ baseUrl: baseUrl(), token: token() });
}
