// High-level refresh orchestrator.
//
// `getValidAccessToken` is the function the IMAP/SMTP layer (and any
// future Gmail/Graph REST clients) calls to obtain a usable bearer
// token. It hides the per-provider quirks behind one signature and
// only hits the wire when the cached token is within a small skew
// window of expiry.
//
// IMPORTANT: this module never calls Nango. Nango's role ends after
// the initial connect; from there on we own the refresh cycle.

import type { OauthAccountRow, OauthAccountsRepository } from "@mailai/overlay-db";
import { MailaiError } from "@mailai/core";
import { OauthRefreshError, type OauthCredentials, type RefreshedToken } from "./types.js";
import { refreshGoogleAccessToken } from "./google.js";
import { refreshMicrosoftAccessToken } from "./microsoft.js";

const DEFAULT_SKEW_MS = 5 * 60 * 1000; // refresh 5 min before expiry

export interface ProviderCredentials {
  readonly google?: OauthCredentials;
  readonly microsoft?: OauthCredentials;
}

export interface GetValidAccessTokenDeps {
  readonly tenantId: string;
  readonly accounts: OauthAccountsRepository;
  readonly credentials: ProviderCredentials;
  readonly now?: () => Date;
  readonly skewMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export async function getValidAccessToken(
  account: OauthAccountRow,
  deps: GetValidAccessTokenDeps,
): Promise<string> {
  const now = deps.now ?? (() => new Date());
  const skew = deps.skewMs ?? DEFAULT_SKEW_MS;

  const fresh = account.expiresAt && account.expiresAt.getTime() - now().getTime() > skew;
  if (fresh) return account.accessToken;

  if (account.status === "revoked") {
    throw new MailaiError("auth_error", `oauth account ${account.id} is revoked`);
  }
  if (!account.refreshToken) {
    throw new MailaiError(
      "auth_error",
      `oauth account ${account.id} has no refresh token; user must re-authorize`,
    );
  }

  const refreshed = await refreshOnce(account, deps);
  await deps.accounts.updateTokens(deps.tenantId, account.id, {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? account.refreshToken, // keep old if not rotated
    expiresAt: refreshed.expiresAt,
    scope: refreshed.scope,
    status: "ok",
  });
  return refreshed.accessToken;
}

async function refreshOnce(
  account: OauthAccountRow,
  deps: GetValidAccessTokenDeps,
): Promise<RefreshedToken> {
  if (!account.refreshToken) throw new Error("refreshOnce called without refresh_token");
  try {
    if (account.provider === "google-mail") {
      const creds = deps.credentials.google;
      if (!creds) {
        throw new MailaiError(
          "auth_error",
          "no google OAuth client credentials configured; set GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET",
        );
      }
      const opts: Parameters<typeof refreshGoogleAccessToken>[0] = {
        refreshToken: account.refreshToken,
        credentials: creds,
      };
      if (deps.fetchImpl) opts.fetchImpl = deps.fetchImpl;
      if (deps.now) opts.now = deps.now;
      return await refreshGoogleAccessToken(opts);
    }
    if (account.provider === "outlook") {
      const creds = deps.credentials.microsoft;
      if (!creds) {
        throw new MailaiError(
          "auth_error",
          "no microsoft OAuth client credentials configured; set MICROSOFT_OAUTH_CLIENT_ID / MICROSOFT_OAUTH_CLIENT_SECRET",
        );
      }
      const opts: Parameters<typeof refreshMicrosoftAccessToken>[0] = {
        refreshToken: account.refreshToken,
        credentials: creds,
      };
      if (deps.fetchImpl) opts.fetchImpl = deps.fetchImpl;
      if (deps.now) opts.now = deps.now;
      return await refreshMicrosoftAccessToken(opts);
    }
    const provider: never = account.provider;
    throw new Error(`unknown oauth provider: ${String(provider)}`);
  } catch (err) {
    if (err instanceof OauthRefreshError && err.needsReauth) {
      await deps.accounts.markStatus(deps.tenantId, account.id, "needs-reauth");
    }
    throw err;
  }
}

export function loadProviderCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProviderCredentials {
  const out: { google?: OauthCredentials; microsoft?: OauthCredentials } = {};
  const gId = env["GOOGLE_OAUTH_CLIENT_ID"];
  const gSecret = env["GOOGLE_OAUTH_CLIENT_SECRET"];
  if (gId && gSecret) {
    out.google = { clientId: gId, clientSecret: gSecret };
  }
  const mId = env["MICROSOFT_OAUTH_CLIENT_ID"];
  const mSecret = env["MICROSOFT_OAUTH_CLIENT_SECRET"];
  if (mId && mSecret) {
    const cfg: OauthCredentials = {
      clientId: mId,
      clientSecret: mSecret,
      tenant: env["MICROSOFT_OAUTH_TENANT"] ?? "common",
    };
    out.microsoft = cfg;
  }
  return out;
}
