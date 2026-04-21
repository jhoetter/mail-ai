// Microsoft OAuth2 wrapper using MSAL Node. Issues XOAUTH2 access
// tokens for IMAP/SMTP against outlook.office365.com.

import { ConfidentialClientApplication } from "@azure/msal-node";

export interface MicrosoftOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tenantId: string; // 'common' for multi-tenant
  readonly redirectUri: string;
}

const SCOPES = [
  "offline_access",
  "https://outlook.office.com/IMAP.AccessAsUser.All",
  "https://outlook.office.com/SMTP.Send",
];

export class MicrosoftOAuth {
  private readonly app: ConfidentialClientApplication;
  constructor(private readonly cfg: MicrosoftOAuthConfig) {
    this.app = new ConfidentialClientApplication({
      auth: {
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
        authority: `https://login.microsoftonline.com/${cfg.tenantId}`,
      },
    });
  }

  async authUrl(state: string): Promise<string> {
    return this.app.getAuthCodeUrl({
      scopes: SCOPES,
      redirectUri: this.cfg.redirectUri,
      state,
    });
  }

  async exchangeCode(code: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }> {
    const result = await this.app.acquireTokenByCode({
      code,
      scopes: SCOPES,
      redirectUri: this.cfg.redirectUri,
    });
    if (!result?.accessToken) throw new Error("Microsoft did not return access token");
    // MSAL handles refresh tokens internally; the cache token is what
    // we persist. For simplicity here we serialize to a synthetic
    // refresh_token we'll pass back via acquireTokenByRefreshToken.
    return {
      accessToken: result.accessToken,
      refreshToken: result.account?.homeAccountId ?? "",
      expiresAt: result.expiresOn?.getTime() ?? Date.now() + 3500 * 1000,
    };
  }

  async refresh(refreshToken: string): Promise<{ accessToken: string; expiresAt: number }> {
    const result = await this.app.acquireTokenByRefreshToken({
      refreshToken,
      scopes: SCOPES,
    });
    if (!result?.accessToken) throw new Error("MS refresh returned no access token");
    return {
      accessToken: result.accessToken,
      expiresAt: result.expiresOn?.getTime() ?? Date.now() + 3500 * 1000,
    };
  }
}
