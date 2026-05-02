import { apiFetch } from "./api";

/**
 * When MailAI verifies `Authorization: Bearer` (hof-os JWT mode), inline
 * images use plain GETs — they cannot send that header. The API also accepts
 * the same JWT as an HttpOnly `hof_subapp_session` cookie (`hof-jwt.ts`).
 *
 * SSO handoff sets that cookie on redirect; clients that authenticate only via
 * Bearer (embedded shell, programmatic tokens) must call this once after the
 * token is available so `<img src=".../attachments/.../inline">` succeeds.
 */
export async function syncSubappSessionCookie(): Promise<void> {
  try {
    const res = await apiFetch("/api/auth/session-cookie", {
      method: "POST",
    });
    if (!res.ok && res.status !== 401) {
      console.warn("[mailai] POST /api/auth/session-cookie failed:", res.status);
    }
  } catch {
    // Offline or CORS noise during boot — reader still works except inline imgs.
  }
}
