// Google OAuth 2.0 refresh.
//
// Endpoint: https://oauth2.googleapis.com/token
// Body (application/x-www-form-urlencoded):
//   grant_type=refresh_token
//   refresh_token=<rt>
//   client_id=<id>
//   client_secret=<secret>
//
// Google rotates the refresh_token only on first issuance; subsequent
// refreshes return only a new access_token. We surface that as
// `refreshToken: null` so the repo knows to keep the existing one.

import { OauthRefreshError, type OauthCredentials, type RefreshedToken } from "./types.js";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

export async function refreshGoogleAccessToken(args: {
  refreshToken: string;
  credentials: OauthCredentials;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<RefreshedToken> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const now = args.now ?? (() => new Date());
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
    client_id: args.credentials.clientId,
    client_secret: args.credentials.clientSecret,
  });
  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    const errCode =
      typeof (parsed as { error?: string }).error === "string"
        ? (parsed as { error: string }).error
        : "";
    throw new OauthRefreshError({
      provider: "google-mail",
      status: res.status,
      body: parsed,
      needsReauth: errCode === "invalid_grant",
      message: `google refresh failed: ${res.status} ${errCode || res.statusText}`,
    });
  }
  const t = parsed as GoogleTokenResponse;
  if (!t.access_token || typeof t.expires_in !== "number") {
    throw new OauthRefreshError({
      provider: "google-mail",
      status: res.status,
      body: parsed,
      needsReauth: false,
      message: "google refresh missing access_token / expires_in",
    });
  }
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? null,
    expiresAt: new Date(now().getTime() + t.expires_in * 1000),
    scope: t.scope ?? null,
    tokenType: t.token_type ?? "Bearer",
  };
}
