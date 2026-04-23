// Thin client wrapper used by the apps/web Vite SPA. The real
// transport lives in @mailai/agent's HttpAgentClient; this module
// just adapts request defaults (base URL, token resolution) to the
// host environment. Same JSON contract end-to-end.
//
// In embedded mode (mounted from `@mailai/react-app/MailAiApp`),
// `runtime-config.ts` overrides `baseUrl()` so URLs resolve under the
// host's `/api/mail/*` proxy and adds `Authorization: Bearer <jwt>`
// headers via `apiFetch` / the async `client()`. Standalone deployments
// are unaffected — both helpers fall back to the historical defaults
// when no runtime config is set.

import { HttpAgentClient } from "@mailai/agent";
import { getRuntimeConfig, runtimeApiBase, runtimeAuthHeaders } from "./runtime-config";

export function baseUrl(): string {
  return runtimeApiBase();
}

function legacyLocalStorageToken(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem("mailai.token") ?? "";
}

/**
 * Resolve the bearer token to attach to outbound requests. Embed mode
 * mints a fresh JWT via the host's `getAuthToken` callback (cached in
 * `runtime-config`); standalone mode keeps reading from the historic
 * `mailai.token` localStorage key, which is still set by the legacy
 * `apps/web` device-pairing flow.
 */
async function resolveToken(): Promise<string> {
  const cfg = getRuntimeConfig();
  if (cfg) {
    try {
      const tok = await cfg.getAuthToken();
      if (tok) return tok;
    } catch {
      // fall through to legacy
    }
  }
  return legacyLocalStorageToken();
}

/**
 * Build a fresh `HttpAgentClient` with the current base URL + token.
 *
 * Async because the embed token is short-lived and refreshed lazily by
 * the host: every call site must `await client()` so we re-read the
 * cached token before issuing the request. Caller patterns
 * (`(await client()).applyCommand(...)`) read naturally inside the
 * async event handlers that wrap every command in the UI.
 */
export async function client(): Promise<HttpAgentClient> {
  const tok = await resolveToken();
  return new HttpAgentClient({ baseUrl: baseUrl(), token: tok });
}

/**
 * `fetch` wrapper that:
 *
 * - Prefixes `path` with the current `baseUrl()` (so `/api/threads`
 *   becomes `<base>/api/threads` and embedded mode automatically lands
 *   on `/api/mail/api/threads`).
 * - Merges in the embed's auth headers when set, leaving caller-
 *   supplied headers as the highest-priority override.
 * - Defaults to `same-origin` credentials so CSRF/cookie flows behave
 *   like the previous bare-`fetch` calls did.
 *
 * Every `*-client.ts` helper should go through this instead of calling
 * `fetch(\`${baseUrl()}${path}\`, ...)` directly so the auth + base
 * seam stays in one place.
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = `${baseUrl()}${path}`;
  const authHeaders = await runtimeAuthHeaders();
  const mergedHeaders = mergeHeaders(authHeaders, init.headers);
  return fetch(url, {
    credentials: init.credentials ?? "same-origin",
    ...init,
    headers: mergedHeaders,
  });
}

function mergeHeaders(
  base: Record<string, string>,
  override: HeadersInit | undefined,
): HeadersInit {
  if (!override) return base;
  if (override instanceof Headers) {
    const out: Record<string, string> = { ...base };
    override.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(override)) {
    const out: Record<string, string> = { ...base };
    for (const [k, v] of override) {
      out[k] = v;
    }
    return out;
  }
  return { ...base, ...(override as Record<string, string>) };
}
