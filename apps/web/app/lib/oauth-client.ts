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
  lastSyncedAt: string | null;
  lastSyncError: string | null;
}

export type SyncFolder =
  | "inbox"
  | "sent"
  | "drafts"
  | "trash"
  | "spam"
  | "archive";

export interface SyncResult {
  fetched: number;
  inserted: number;
  updated: number;
  durationMs: number;
  // Per-folder breakdown returned by the multi-folder sync. Always
  // non-empty in v0.4+; older servers omit it (we treat that as
  // [{ folder: 'inbox', fetched }] for back-compat).
  perFolder?: { folder: SyncFolder; fetched: number }[];
}

export interface SyncOptions {
  // Comma-listed folders. Omitted = server default
  // (inbox + sent + drafts).
  folders?: ReadonlyArray<SyncFolder>;
  // Backfill depth in pages per folder. Omitted = server default (5).
  backfillPages?: number;
}

export interface FinalizeResponse extends AccountSummary {
  initialSync:
    | ({ status: "ok" } & SyncResult)
    | { status: "pending" };
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
}): Promise<FinalizeResponse> {
  const res = await fetch(`${baseUrl()}/api/oauth/finalize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  return jsonOrThrow<FinalizeResponse>(res);
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

export async function syncAccount(
  id: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const params = new URLSearchParams();
  if (opts.folders && opts.folders.length > 0) {
    params.set("folders", opts.folders.join(","));
  }
  if (opts.backfillPages) {
    params.set("backfill", String(opts.backfillPages));
  }
  const qs = params.toString();
  const url = `${baseUrl()}/api/accounts/${encodeURIComponent(id)}/sync${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, { method: "POST" });
  return jsonOrThrow<SyncResult>(res);
}
