// Recipient autocomplete endpoints.
//
//   GET  /api/contacts/suggest?q=…&accountId=…&limit=8
//      → { items: [{ name, email, source, accountId }] }
//
//   POST /api/contacts/sync
//      → manual full re-sync of every connected account. Cheap (one
//        HTTP fan-out per account) and idempotent. Mirrors
//        /api/calendars/sync so the UI's "Refresh" affordance can
//        share a pattern.
//
// The suggest endpoint is the one that has to stay fast. It serves
// straight from `oauth_contacts` (which is indexed for prefix +
// substring lookups; see migration 0016_oauth_contacts) and only
// kicks a background sync — no await — when the cache is older than
// CONTACT_FRESHNESS_MS for some account. This means the user never
// waits on the provider for typing latency.

import type { FastifyInstance } from "fastify";
import {
  OauthAccountsRepository,
  OauthContactsRepository,
  withTenant,
  type Pool,
} from "@mailai/overlay-db";
import { type ProviderCredentials } from "@mailai/oauth-tokens";
import type { ContactsProviderRegistry } from "@mailai/providers";
import {
  CONTACT_FRESHNESS_MS,
  hasRequiredContactScopes,
  syncContactsForAccount,
} from "../handlers/contacts.js";

export interface ContactsRoutesDeps {
  readonly pool: Pool;
  readonly identity: (req: { headers: Record<string, unknown> }) => Promise<{
    userId: string;
    tenantId: string;
  }>;
  readonly credentials?: ProviderCredentials;
  // Required when `credentials` is supplied (we'd otherwise have
  // tokens but no surface to call). Optional overall so the routes
  // can still mount in test harnesses that skip provider wiring.
  readonly contactsProviders?: ContactsProviderRegistry;
}

export function registerContactsRoutes(
  app: FastifyInstance,
  deps: ContactsRoutesDeps,
): void {
  app.get("/api/contacts/suggest", async (req) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const q = (req.query as { q?: string }).q ?? "";
    const accountId = (req.query as { accountId?: string }).accountId;
    const rawLimit = (req.query as { limit?: string }).limit;
    const limit = rawLimit ? Math.min(Math.max(Number(rawLimit) || 8, 1), 20) : 8;
    const trimmed = q.trim();
    if (trimmed.length === 0) {
      return { items: [], reconnect: [] };
    }

    const result = await withTenant(deps.pool, ident.tenantId, async (tx) => {
      const contactsRepo = new OauthContactsRepository(tx);
      const accountsRepo = new OauthAccountsRepository(tx);
      const items = await contactsRepo.searchContacts({
        tenantId: ident.tenantId,
        ...(accountId ? { oauthAccountId: accountId } : {}),
        q: trimmed,
        limit,
      });
      const accounts = await accountsRepo.listByTenant(ident.tenantId);
      const freshness = await contactsRepo.freshness(ident.tenantId);
      return { items, accounts, freshness };
    });

    // Detect accounts that haven't been refreshed within the
    // freshness window AND have the required scope. We fire a
    // background sync for those — no await — and return immediately
    // with whatever was cached.
    if (deps.credentials && deps.contactsProviders) {
      const credentials = deps.credentials;
      const contactsProviders = deps.contactsProviders;
      const now = Date.now();
      for (const account of result.accounts) {
        if (!hasRequiredContactScopes(account)) continue;
        const newest = result.freshness
          .filter((f) => f.oauthAccountId === account.id)
          .reduce<Date | null>(
            (acc, f) => (acc === null || f.fetchedAt > acc ? f.fetchedAt : acc),
            null,
          );
        const stale = newest === null || now - newest.getTime() > CONTACT_FRESHNESS_MS;
        if (!stale) continue;
        // Background fire-and-forget. Each kick gets its own
        // transaction so they don't interleave with a long-running
        // search query holding tx state.
        void withTenant(deps.pool, ident.tenantId, async (tx) => {
          const accountsRepo = new OauthAccountsRepository(tx);
          const contactsRepo = new OauthContactsRepository(tx);
          await syncContactsForAccount(account, {
            accounts: accountsRepo,
            contacts: contactsRepo,
            credentials,
            contactsProviders,
          });
        }).catch((err) => {
          app.log.warn({ err, accountId: account.id }, "background contacts sync failed");
        });
      }
    }

    // Surface any account that's missing the required scope so the
    // UI can render a "Reconnect for contacts" hint instead of
    // silently returning empty. We never block the suggestion list
    // on this — it's an additional payload field.
    const reconnect = result.accounts
      .filter((a) => !hasRequiredContactScopes(a))
      .map((a) => ({ id: a.id, provider: a.provider, email: a.email }));

    return {
      items: result.items.map((it) => ({
        id: it.id,
        name: it.displayName,
        email: it.email,
        source: it.source,
        accountId: it.oauthAccountId,
      })),
      reconnect,
    };
  });

  app.post("/api/contacts/sync", async (req) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    if (!deps.credentials || !deps.contactsProviders) {
      return { synced: 0, skipped: "no provider credentials configured" };
    }
    const credentials = deps.credentials;
    const contactsProviders = deps.contactsProviders;
    return withTenant(deps.pool, ident.tenantId, async (tx) => {
      const accountsRepo = new OauthAccountsRepository(tx);
      const contactsRepo = new OauthContactsRepository(tx);
      const accounts = await accountsRepo.listByTenant(ident.tenantId);
      let synced = 0;
      const accountsResults: Array<{
        accountId: string;
        ok: boolean;
        error?: string;
      }> = [];
      for (const account of accounts) {
        if (!hasRequiredContactScopes(account)) {
          accountsResults.push({
            accountId: account.id,
            ok: false,
            error: "missing_scope",
          });
          continue;
        }
        try {
          const r = await syncContactsForAccount(account, {
            accounts: accountsRepo,
            contacts: contactsRepo,
            credentials,
            contactsProviders,
          });
          synced += r.perSource.reduce((n, s) => n + s.fetched, 0);
          accountsResults.push({ accountId: account.id, ok: true });
        } catch (err) {
          accountsResults.push({
            accountId: account.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return { synced, accounts: accountsResults };
    });
  });
}
