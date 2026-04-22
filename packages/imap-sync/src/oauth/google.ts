// Google OAuth2 wrapper. Issues XOAUTH2 access tokens for IMAP/SMTP.
// Per RFC SASL-XOAUTH2 we hand the raw access token to imapflow which
// formats the bearer string itself.

import { OAuth2Client } from "google-auth-library";

export interface GoogleOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

// Default OAuth scopes requested when callers don't pass an override.
//
// `mail.google.com` is the IMAP/SMTP scope (XOAUTH2 over both); the two
// People-API scopes power the recipient autocomplete dropdown in the
// composer:
//   - contacts.readonly       → `people/me/connections` ("My contacts")
//   - contacts.other.readonly → `otherContacts` (auto-collected from
//                               anyone the user has emailed; this is
//                               the population Gmail draws on for
//                               "type 'jt' → suggest jt.hoetter@…")
//
// Existing accounts keep working without these scopes; the suggest
// endpoint surfaces a "Reconnect for contacts" hint when they're
// missing rather than failing silently.
export const GOOGLE_DEFAULT_SCOPES = [
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/contacts.other.readonly",
] as const;

export class GoogleOAuth {
  private readonly client: OAuth2Client;
  constructor(cfg: GoogleOAuthConfig) {
    this.client = new OAuth2Client(cfg.clientId, cfg.clientSecret, cfg.redirectUri);
  }

  authUrl(scopes: readonly string[] = GOOGLE_DEFAULT_SCOPES): string {
    return this.client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: [...scopes],
    });
  }

  async exchangeCode(code: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }> {
    const { tokens } = await this.client.getToken(code);
    if (!tokens.access_token || !tokens.refresh_token) {
      throw new Error("Google did not return both access and refresh tokens");
    }
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expiry_date ?? Date.now() + 3500 * 1000,
    };
  }

  async refresh(refreshToken: string): Promise<{ accessToken: string; expiresAt: number }> {
    this.client.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await this.client.refreshAccessToken();
    if (!credentials.access_token) throw new Error("refresh did not return access token");
    return {
      accessToken: credentials.access_token,
      expiresAt: credentials.expiry_date ?? Date.now() + 3500 * 1000,
    };
  }
}
