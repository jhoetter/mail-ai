// Browser-side wrapper around the /api/oauth/* endpoints. Kept tiny on
// purpose — Nango's frontend SDK does the actual popup work, this
// module just talks to our server.

import { baseUrl } from "./api";

export type ConnectProvider = "google-mail" | "outlook";

export interface ConnectSessionResponse {
  token: string;
  expiresAt: string;
  provider: ConnectProvider;
  providerConfigKey: string;
}

export interface AccountSummary {
  id: string;
  provider: string;
  email: string;
  status: "ok" | "needs-reauth" | "revoked";
  expiresAt: string | null;
  createdAt: string;
}

export interface OauthApiError {
  error: string;
  message?: string;
  docs?: string;
}

export class OauthHttpError extends Error {
  readonly status: number;
  readonly body: OauthApiError;
  constructor(status: number, body: OauthApiError) {
    super(body.message ?? body.error ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { error: "non_json_response", message: text };
  }
  if (!res.ok) {
    throw new OauthHttpError(res.status, parsed as OauthApiError);
  }
  return parsed as T;
}

export async function createConnectSession(
  provider: ConnectProvider,
): Promise<ConnectSessionResponse> {
  const res = await fetch(`${baseUrl()}/api/oauth/connect-session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider }),
  });
  return jsonOrThrow<ConnectSessionResponse>(res);
}

export async function finalizeConnection(args: {
  provider: ConnectProvider;
  connectionId: string;
}): Promise<AccountSummary> {
  const res = await fetch(`${baseUrl()}/api/oauth/finalize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  return jsonOrThrow<AccountSummary>(res);
}

export async function listAccounts(): Promise<AccountSummary[]> {
  const res = await fetch(`${baseUrl()}/api/accounts`);
  const data = await jsonOrThrow<{ accounts: AccountSummary[] }>(res);
  return data.accounts;
}

export async function deleteAccount(id: string): Promise<void> {
  const res = await fetch(`${baseUrl()}/api/accounts/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  await jsonOrThrow<{ ok: true }>(res);
}
