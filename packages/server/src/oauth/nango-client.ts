// Thin Nango REST client.
//
// We deliberately don't pull in `@nangohq/node` on the server side:
//
//   1. We only call two endpoints (create connect session, fetch
//      connection-by-id) and the responses are stable.
//   2. mail-ai's headless surface forbids extra deps without a strong
//      reason; one fetch wrapper is easier to audit than a vendor SDK.
//
// Nango Cloud base URL is https://api.nango.dev. Self-hosted users can
// override with NANGO_HOST. Auth is Bearer NANGO_SECRET_KEY.

export interface NangoConfig {
  readonly secretKey: string;
  readonly host: string; // e.g. https://api.nango.dev
}

export interface ConnectSessionRequest {
  // End-user that's about to authorize. Surfaced in the Nango UI.
  readonly endUser: { id: string; email?: string; displayName?: string };
  // Which Nango integration(s) the user is allowed to pick from. We
  // pin to the single one they clicked (Gmail or Outlook) so the
  // popup goes straight to the provider.
  readonly allowedIntegrations: readonly string[];
}

export interface ConnectSessionResponse {
  readonly token: string;
  readonly expiresAt: string; // ISO
}

// Shape of a Nango connection. Nango's API returns a `credentials`
// object whose layout depends on the auth mode. For OAuth2 we get
// access_token, refresh_token, expires_at (ISO string), raw token
// payload, etc. We type only what we use; the rest goes into rawJson.
export interface NangoOAuthCredentials {
  readonly type: "OAUTH2" | "OAUTH1" | string;
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_at?: string;
  readonly raw?: { scope?: string; token_type?: string; expires_in?: number };
}

export interface NangoConnection {
  readonly id?: number | string;
  readonly connection_id: string;
  readonly provider_config_key: string;
  readonly provider: string;
  readonly credentials: NangoOAuthCredentials;
  readonly metadata?: Record<string, unknown> | null;
  readonly connection_config?: Record<string, unknown> | null;
}

export class NangoClient {
  constructor(private readonly cfg: NangoConfig) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.secretKey}`,
      "Content-Type": "application/json",
    };
  }

  async createConnectSession(req: ConnectSessionRequest): Promise<ConnectSessionResponse> {
    const url = `${trimSlash(this.cfg.host)}/connect/sessions`;
    const body = {
      end_user: {
        id: req.endUser.id,
        ...(req.endUser.email ? { email: req.endUser.email } : {}),
        ...(req.endUser.displayName ? { display_name: req.endUser.displayName } : {}),
      },
      allowed_integrations: [...req.allowedIntegrations],
    };
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`nango create-session failed: ${res.status} ${txt}`);
    }
    const json = (await res.json()) as { data?: { token: string; expires_at: string } };
    if (!json.data?.token) {
      throw new Error("nango create-session: missing data.token");
    }
    return { token: json.data.token, expiresAt: json.data.expires_at };
  }

  async getConnection(args: {
    connectionId: string;
    providerConfigKey: string;
  }): Promise<NangoConnection> {
    const url = new URL(
      `${trimSlash(this.cfg.host)}/connection/${encodeURIComponent(args.connectionId)}`,
    );
    url.searchParams.set("provider_config_key", args.providerConfigKey);
    url.searchParams.set("refresh_token", "true");
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: this.headers(),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`nango get-connection failed: ${res.status} ${txt}`);
    }
    return (await res.json()) as NangoConnection;
  }
}

function trimSlash(u: string): string {
  return u.endsWith("/") ? u.slice(0, -1) : u;
}
