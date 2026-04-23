// Per-account address book sync.
//
// Mirrors the calendar sync slice (see routes/calendar.ts): one
// HTTP fan-out per oauth account, idempotent upsert into
// `oauth_contacts`, source-scoped delete-missing so removed
// contacts disappear without us needing tombstones provider-side.
//
// Strategy:
//   - Full re-sync once per CONTACT_FRESHNESS_MS per (account,
//     source). Address books churn slowly so 24h is plenty.
//   - Lazy refresh: the suggest route compares freshness() against
//     the window and kicks `syncContactsForAccount` on a stale
//     account in the background (no await) so the user sees cached
//     results immediately.
//   - We never throw across accounts: a 401 on one mailbox must
//     not sink the others. Errors are logged via the caller; the
//     sync tagged result counts what landed.

import { randomUUID } from "node:crypto";
import {
  type OauthAccountRow,
  type OauthAccountsRepository,
  type OauthContactInsert,
  type OauthContactsRepository,
} from "@mailai/overlay-db";
import { getValidAccessToken, type ProviderCredentials } from "@mailai/oauth-tokens";
import type { ContactsProviderRegistry } from "@mailai/providers";
import {
  pickPrimaryEmail,
  type ContactSource,
  type NormalizedContact,
} from "@mailai/providers/contacts";

// 24 hours. Contacts churn slowly enough that this is comfortable;
// the freshness threshold matches Gmail's own perceived latency for
// new addresses ("emailed someone yesterday → appears today").
export const CONTACT_FRESHNESS_MS = 24 * 60 * 60 * 1000;

export interface ContactsSyncDeps {
  readonly accounts: OauthAccountsRepository;
  readonly contacts: OauthContactsRepository;
  readonly credentials: ProviderCredentials;
  // Provider-agnostic surface; the per-source fan-out below picks
  // `listOwn/Other/Frequent` off the adapter so we don't have to
  // branch on `account.provider` in the handler.
  readonly contactsProviders: ContactsProviderRegistry;
  readonly fetchImpl?: typeof fetch;
}

export interface ContactsSyncResult {
  readonly accountId: string;
  readonly perSource: { source: ContactSource; fetched: number; deleted: number }[];
  readonly durationMs: number;
}

// Required scope strings, keyed by provider. We compare these
// against `oauth_accounts.scope` (a space-separated string) so the
// suggest route can surface "Reconnect to enable contact
// suggestions" without hitting the provider and getting a 403.
export const REQUIRED_SCOPES: Record<"google-mail" | "outlook", readonly string[]> = {
  "google-mail": [
    "https://www.googleapis.com/auth/contacts.readonly",
    "https://www.googleapis.com/auth/contacts.other.readonly",
  ],
  outlook: ["https://graph.microsoft.com/Contacts.Read", "https://graph.microsoft.com/People.Read"],
};

export function hasRequiredContactScopes(account: OauthAccountRow): boolean {
  const granted = (account.scope ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (granted.length === 0) return false;
  const required = REQUIRED_SCOPES[account.provider];
  // Match if the account has at least ONE of the required scopes.
  // Google sometimes returns the abbreviated scope ("contacts.readonly")
  // depending on consent path; Graph normalises to the full URL. We
  // allow either by matching on suffix.
  return required.some((req) =>
    granted.some((g) => g === req.toLowerCase() || req.toLowerCase().endsWith(`/${g}`)),
  );
}

export async function syncContactsForAccount(
  account: OauthAccountRow,
  deps: ContactsSyncDeps,
): Promise<ContactsSyncResult> {
  const t0 = Date.now();
  const accessToken = await getValidAccessToken(account, {
    tenantId: account.tenantId,
    accounts: deps.accounts,
    credentials: deps.credentials,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });

  const perSource: ContactsSyncResult["perSource"] = [];

  const adapter = deps.contactsProviders.for(account.provider);
  if (!adapter) {
    throw new Error(`no contacts adapter registered for provider ${account.provider}`);
  }

  // Fan out across the three normalized sources. Adapters that don't
  // support a source return [] (capability also says false), which
  // applySource below handles correctly: it will delete-missing the
  // empty set, leaving any prior cache for that source intact.
  if (adapter.capabilities.ownContacts) {
    const my = await safeList(() =>
      Promise.resolve(adapter.listOwnContacts({ accessToken })).then((r) => [...r]),
    );
    perSource.push(await applySource(deps, account, "my", my));
  }
  if (adapter.capabilities.otherContacts) {
    const other = await safeList(() =>
      Promise.resolve(adapter.listOtherContacts({ accessToken })).then((r) => [...r]),
    );
    perSource.push(await applySource(deps, account, "other", other));
  }
  if (adapter.capabilities.frequentPeople) {
    const people = await safeList(() =>
      Promise.resolve(adapter.listFrequent({ accessToken })).then((r) => [...r]),
    );
    perSource.push(await applySource(deps, account, "people", people));
  }

  return {
    accountId: account.id,
    perSource,
    durationMs: Date.now() - t0,
  };
}

async function applySource(
  deps: ContactsSyncDeps,
  account: OauthAccountRow,
  source: ContactSource,
  contacts: NormalizedContact[],
): Promise<{ source: ContactSource; fetched: number; deleted: number }> {
  const inserts: OauthContactInsert[] = [];
  for (const c of contacts) {
    const primary = pickPrimaryEmail(c.emails);
    if (!primary) continue;
    inserts.push({
      id: `oc_${randomUUID()}`,
      tenantId: account.tenantId,
      oauthAccountId: account.id,
      provider: account.provider,
      providerContactId: c.providerContactId,
      source,
      displayName: c.displayName,
      primaryEmail: primary,
      emails: [...c.emails],
      ...(c.lastInteractionAt ? { lastInteractionAt: c.lastInteractionAt } : {}),
    });
  }
  await deps.contacts.upsertMany(inserts);
  const deleted = await deps.contacts.deleteMissing({
    oauthAccountId: account.id,
    source,
    keepProviderContactIds: contacts.map((c) => c.providerContactId),
  });
  return { source, fetched: inserts.length, deleted };
}

async function safeList(fn: () => Promise<NormalizedContact[]>): Promise<NormalizedContact[]> {
  try {
    return await fn();
  } catch (err) {
    // Missing scope or transient 5xx — leave the existing cache
    // intact and surface zero new contacts. The suggest route's
    // missing-scope hint is the user-visible recovery path.
    console.warn("[contacts] provider list failed", { err: String(err) });
    return [];
  }
}
