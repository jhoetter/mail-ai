// Microsoft Identity Platform OAuth 2.0 refresh.
//
// Endpoint: https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
// {tenant} is one of:
//   - 'common'         multi-tenant + personal (default for outlook.com + work)
//   - 'consumers'      personal MSA accounts only
//   - 'organizations'  any AAD tenant
//   - <tenant GUID>    single tenant
//
// Microsoft returns a fresh refresh_token on every call (rolling RTs)
// when the app is not configured as confidential public client without
// rotation; we always persist whatever they send back.

import { OauthRefreshError, type OauthCredentials, type RefreshedToken } from "./types.js";

interface MsTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  ext_expires_in?: number;
}

export async function refreshMicrosoftAccessToken(args: {
  refreshToken: string;
  credentials: OauthCredentials;
  scopes?: readonly string[];
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<RefreshedToken> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const now = args.now ?? (() => new Date());
  const tenant = args.credentials.tenant ?? "common";
  const url = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
    client_id: args.credentials.clientId,
    client_secret: args.credentials.clientSecret,
  });
  if (args.scopes && args.scopes.length > 0) {
    params.set("scope", args.scopes.join(" "));
  }
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
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
      provider: "outlook",
      status: res.status,
      body: parsed,
      needsReauth: errCode === "invalid_grant" || errCode === "interaction_required",
      message: `microsoft refresh failed: ${res.status} ${errCode || res.statusText}`,
    });
  }
  const t = parsed as MsTokenResponse;
  if (!t.access_token || typeof t.expires_in !== "number") {
    throw new OauthRefreshError({
      provider: "outlook",
      status: res.status,
      body: parsed,
      needsReauth: false,
      message: "microsoft refresh missing access_token / expires_in",
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
