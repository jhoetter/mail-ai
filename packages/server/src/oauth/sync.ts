// Initial / on-demand REST sync for OAuth-connected accounts.
//
// This is the bridge between an `oauth_accounts` row (which Nango
// hands us during onboarding) and the `oauth_messages` table the
// inbox UI reads from. It pulls the last N INBOX message metadata
// items via the provider's REST API and upserts them.
//
// Deliberately small surface:
//   - one entry point: `syncOauthAccount`
//   - reads/refreshes tokens via @mailai/oauth-tokens
//   - writes via OauthMessagesRepository + OauthAccountsRepository.markSync
//   - returns counts so the UI can show "Synced 27 messages"
//
// Bigger sync (history-id watermarks, polling worker, IMAP XOAUTH2)
// belongs in its own module/package once we wire continuous fetch.

import {
  type OauthAccountRow,
  type OauthAccountsRepository,
  type OauthMessageInsert,
  type OauthMessagesRepository,
} from "@mailai/overlay-db";
import {
  getValidAccessToken,
  listGmailInboxIds,
  getGmailMessageMetadata,
  listGraphInboxMessages,
  type ProviderCredentials,
} from "@mailai/oauth-tokens";

// All three repos must be created inside the SAME `withTenant`
// transaction so RLS sees `mailai.tenant_id` set and the token-refresh
// writes + message upserts + sync bookkeeping land atomically.
export interface SyncDeps {
  readonly accounts: OauthAccountsRepository;
  readonly messages: OauthMessagesRepository;
  readonly credentials: ProviderCredentials;
  readonly maxResults?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface SyncResult {
  readonly fetched: number;
  readonly inserted: number;
  readonly updated: number;
  readonly durationMs: number;
}

export async function syncOauthAccount(
  account: OauthAccountRow,
  deps: SyncDeps,
): Promise<SyncResult> {
  const t0 = Date.now();
  const max = deps.maxResults ?? 30;

  let result: SyncResult;
  try {
    const accessToken = await getValidAccessToken(account, {
      tenantId: account.tenantId,
      accounts: deps.accounts,
      credentials: deps.credentials,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });

    const rows = account.provider === "google-mail"
      ? await collectGmail(account, accessToken, max)
      : account.provider === "outlook"
        ? await collectGraph(account, accessToken, max)
        : (() => {
            const _exhaustive: never = account.provider;
            throw new Error(`unknown oauth provider: ${String(_exhaustive)}`);
          })();

    const counts = await deps.messages.upsertMany(rows);
    result = {
      fetched: rows.length,
      inserted: counts.inserted,
      updated: counts.updated,
      durationMs: Date.now() - t0,
    };
    await deps.accounts.markSync(account.tenantId, account.id, {
      at: new Date(),
      error: null,
    });
    return result;
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    await deps.accounts
      .markSync(account.tenantId, account.id, { at: new Date(), error: msg })
      .catch(() => undefined); // never let bookkeeping mask the real error
    throw err;
  }
}

async function collectGmail(
  account: OauthAccountRow,
  accessToken: string,
  max: number,
): Promise<OauthMessageInsert[]> {
  const ids = await listGmailInboxIds({ accessToken, maxResults: max });
  // Fetch in parallel but cap concurrency so we never trip Gmail's
  // 250 quota-units / user / second on big windows. Six is well
  // under the limit even if every message hit happens to retry.
  const fetched = await mapWithConcurrency(ids, 6, (m) =>
    getGmailMessageMetadata({ accessToken, messageId: m.id }),
  );
  return fetched.map((m) => ({
    id: `om_${cryptoRandomUUID()}`,
    tenantId: account.tenantId,
    oauthAccountId: account.id,
    provider: "google-mail",
    providerMessageId: m.id,
    providerThreadId: m.threadId,
    subject: m.subject,
    fromName: m.fromName,
    fromEmail: m.fromEmail,
    toAddr: m.to,
    snippet: m.snippet,
    internalDate: m.internalDate,
    labelsJson: [...m.labelIds],
    unread: m.unread,
  }));
}

async function collectGraph(
  account: OauthAccountRow,
  accessToken: string,
  max: number,
): Promise<OauthMessageInsert[]> {
  const items = await listGraphInboxMessages({ accessToken, maxResults: max });
  return items.map((m) => ({
    id: `om_${cryptoRandomUUID()}`,
    tenantId: account.tenantId,
    oauthAccountId: account.id,
    provider: "outlook",
    providerMessageId: m.id,
    providerThreadId: m.threadId,
    subject: m.subject,
    fromName: m.fromName,
    fromEmail: m.fromEmail,
    toAddr: m.to,
    snippet: m.snippet,
    internalDate: m.internalDate,
    labelsJson: [...m.labelIds],
    unread: m.unread,
  }));
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

function cryptoRandomUUID(): string {
  return crypto.randomUUID();
}
