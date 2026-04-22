// Thin client wrapper used by the apps/web Vite SPA. The real
// transport lives in @mailai/agent's HttpAgentClient; this module
// just adapts request defaults (base URL, token resolution) to the
// host environment. Same JSON contract end-to-end.

import { HttpAgentClient } from "@mailai/agent";

export function baseUrl(): string {
  // Empty string → relative URLs hit the Vite dev server, which is
  // configured (vite.config.ts) to proxy /api/* to the actual API
  // origin. Override with VITE_MAILAI_API_URL when the web app is
  // served from a different origin than the API in production.
  return import.meta.env.VITE_MAILAI_API_URL ?? "";
}

function token(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem("mailai.token") ?? "";
}

export function client(): HttpAgentClient {
  return new HttpAgentClient({ baseUrl: baseUrl(), token: token() });
}
