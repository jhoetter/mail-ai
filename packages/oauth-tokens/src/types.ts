// Provider-agnostic token shape. Returned by every refresh function and
// stored in oauth_accounts. We deliberately keep this normalised so the
// IMAP/SMTP layer (which doesn't care whether the upstream is Gmail or
// Outlook) can consume it through one interface.

export type OauthProvider = "google-mail" | "outlook";

export interface OauthCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  // Microsoft only: 'common' | 'consumers' | 'organizations' | tenant GUID.
  // Defaults to 'common' for outlook.
  readonly tenant?: string;
}

export interface RefreshedToken {
  readonly accessToken: string;
  readonly refreshToken: string | null; // null when the IdP didn't rotate it
  readonly expiresAt: Date;
  readonly scope: string | null;
  readonly tokenType: string;
}

export class OauthRefreshError extends Error {
  readonly provider: OauthProvider;
  readonly status: number;
  readonly body: unknown;
  // True when the refresh_token itself was rejected (invalid_grant) and
  // the user must re-authorize, false for transient errors.
  readonly needsReauth: boolean;
  constructor(args: {
    provider: OauthProvider;
    status: number;
    body: unknown;
    needsReauth: boolean;
    message: string;
  }) {
    super(args.message);
    this.provider = args.provider;
    this.status = args.status;
    this.body = args.body;
    this.needsReauth = args.needsReauth;
  }
}
