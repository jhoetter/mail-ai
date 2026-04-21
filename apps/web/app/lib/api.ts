// Thin client wrapper used by the apps/web Next pages. The real
// transport lives in @mailai/agent's HttpAgentClient; this module
// just adapts request defaults (base URL, token resolution) to the
// host environment. Same JSON contract end-to-end.

import { HttpAgentClient } from "@mailai/agent";

function baseUrl(): string {
  return process.env["NEXT_PUBLIC_MAILAI_API_URL"] ?? "http://127.0.0.1:8080";
}

function token(): string {
  if (typeof window === "undefined") return process.env["MAILAI_TOKEN"] ?? "";
  return window.localStorage.getItem("mailai.token") ?? "";
}

export function client(): HttpAgentClient {
  return new HttpAgentClient({ baseUrl: baseUrl(), token: token() });
}
