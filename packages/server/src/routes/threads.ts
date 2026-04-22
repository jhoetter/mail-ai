// Thread detail + single-message routes for the OAuth-message store.
//
// `/api/threads` (list) lives in oauth/routes.ts because it grew out of
// the OAuth onboarding flow. The detail + single-message reads live
// here because they're consumer-facing reads, not part of onboarding,
// and the CLI's `mail-agent thread show` / `message show` need them.
//
// Body fetch is on-demand: the initial sync only pulls metadata so the
// list view appears immediately. The first time the reader opens a
// thread or message we walk every row whose body_fetched_at is NULL,
// pull text/html bodies from the provider in parallel (capped
// concurrency), and persist them through OauthMessagesRepository.setBody
// so subsequent opens are a pure DB read.
//
// Why fetch the whole thread eagerly: this is what users expect from
// Gmail/Outlook — open a conversation, see every message expanded
// inline. Doing it per-message would mean N requests-on-render in the
// browser; doing it server-side under one route lets us share token
// refresh + concurrency limits.

import type { FastifyInstance } from "fastify";
import {
  OauthAccountsRepository,
  OauthMessagesRepository,
  withTenant,
  type OauthAccountRow,
  type OauthMessageRow,
  type Pool,
} from "@mailai/overlay-db";
import {
  getGmailMessageBody,
  getGraphMessageBody,
  getValidAccessToken,
  type ProviderCredentials,
} from "@mailai/oauth-tokens";

export interface ThreadRoutesDeps {
  readonly pool: Pool;
  readonly credentials: ProviderCredentials;
  readonly identity: (req: { headers: Record<string, unknown> }) => Promise<{
    userId: string;
    tenantId: string;
  }>;
}

export function registerThreadRoutes(app: FastifyInstance, deps: ThreadRoutesDeps): void {
  app.get("/api/threads/:id", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const { id } = req.params as { id: string };

    const initial = await withTenant(deps.pool, ident.tenantId, async (tx) => {
      const repo = new OauthMessagesRepository(tx);
      const root = await repo.byId(ident.tenantId, id);
      if (!root) return null;
      const all = await repo.listByProviderThread(ident.tenantId, root.providerThreadId);
      return { root, all };
    });

    if (!initial) {
      return reply.code(404).send({ error: "not_found", message: `thread ${id} not found` });
    }

    // Lazily backfill bodies for every message in the thread that
    // hasn't been fetched yet. We do it here (and not as a background
    // job) so the reader gets a fully-rendered conversation on first
    // open, which is the core of the user's complaint.
    const filled = await fillBodiesIfMissing(deps, ident.tenantId, initial.all);

    const unreadCount = filled.filter((m) => m.unread).length;
    return {
      id: initial.root.id,
      subject: initial.root.subject ?? "(no subject)",
      providerThreadId: initial.root.providerThreadId,
      provider: initial.root.provider,
      unreadCount,
      messages: filled.map(toMessage),
    };
  });

  app.get("/api/messages/:id", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const { id } = req.params as { id: string };
    const m = await withTenant(deps.pool, ident.tenantId, async (tx) => {
      const repo = new OauthMessagesRepository(tx);
      return repo.byId(ident.tenantId, id);
    });
    if (!m) {
      return reply.code(404).send({ error: "not_found", message: `message ${id} not found` });
    }
    const [filled] = await fillBodiesIfMissing(deps, ident.tenantId, [m]);
    return toMessage(filled ?? m);
  });
}

// Pull bodies from the provider for every message that doesn't have
// one cached, persist them, and return rows reflecting the new state.
// We fetch with capped concurrency to stay well under provider quotas
// (Gmail: 250 quota units / user / second; Graph: ~10k req / 10min).
async function fillBodiesIfMissing(
  deps: ThreadRoutesDeps,
  tenantId: string,
  rows: OauthMessageRow[],
): Promise<OauthMessageRow[]> {
  const missing = rows.filter((m) => m.bodyFetchedAt === null);
  if (missing.length === 0) return rows;

  // Group by oauthAccountId so we resolve a token once per account
  // even when the thread spans multiple connected mailboxes.
  const accountIds = Array.from(new Set(missing.map((m) => m.oauthAccountId)));
  const tokensByAccount = new Map<string, { account: OauthAccountRow; accessToken: string }>();
  await withTenant(deps.pool, tenantId, async (tx) => {
    const repo = new OauthAccountsRepository(tx);
    for (const aid of accountIds) {
      const account = await repo.byId(tenantId, aid);
      if (!account) continue;
      try {
        const accessToken = await getValidAccessToken(account, {
          tenantId,
          accounts: repo,
          credentials: deps.credentials,
        });
        tokensByAccount.set(aid, { account, accessToken });
      } catch (err) {
        // Surface the failure on the row level (body stays null) but
        // don't fail the whole request — other accounts in the thread
        // might still be reachable.
        console.warn(
          "[threads] failed to refresh token for body fetch",
          { accountId: aid, err: String(err) },
        );
      }
    }
  });

  // Fetch in parallel, capped concurrency.
  const fetched = await mapWithConcurrency(missing, 6, async (m) => {
    const tok = tokensByAccount.get(m.oauthAccountId);
    if (!tok) return { id: m.id, text: null as string | null, html: null as string | null };
    try {
      if (tok.account.provider === "google-mail") {
        const b = await getGmailMessageBody({
          accessToken: tok.accessToken,
          messageId: m.providerMessageId,
        });
        return { id: m.id, text: b.text, html: b.html };
      }
      if (tok.account.provider === "outlook") {
        const b = await getGraphMessageBody({
          accessToken: tok.accessToken,
          messageId: m.providerMessageId,
        });
        return { id: m.id, text: b.text, html: b.html };
      }
      return { id: m.id, text: null, html: null };
    } catch {
      // One bad message shouldn't sink the whole thread render.
      // We still mark body_fetched_at so we don't hammer the API on
      // every refresh; the row just stays empty until the user
      // explicitly refreshes the message.
      return { id: m.id, text: null, html: null };
    }
  });

  // Persist in a single transaction.
  await withTenant(deps.pool, tenantId, async (tx) => {
    const repo = new OauthMessagesRepository(tx);
    for (const r of fetched) {
      await repo.setBody(tenantId, r.id, { text: r.text, html: r.html });
    }
  });

  // Patch the in-memory rows so the response reflects what we just
  // wrote without an extra SELECT.
  const byId = new Map(fetched.map((r) => [r.id, r]));
  return rows.map((row) => {
    const b = byId.get(row.id);
    if (!b) return row;
    return {
      ...row,
      bodyText: b.text,
      bodyHtml: b.html,
      bodyFetchedAt: new Date(),
    };
  });
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

function toMessage(m: OauthMessageRow) {
  return {
    id: m.id,
    providerMessageId: m.providerMessageId,
    from: m.fromName || m.fromEmail || "unknown",
    fromName: m.fromName,
    fromEmail: m.fromEmail,
    to: m.toAddr,
    date: m.internalDate.toISOString(),
    snippet: m.snippet,
    unread: m.unread,
    bodyText: m.bodyText,
    bodyHtml: m.bodyHtml,
    bodyFetchedAt: m.bodyFetchedAt ? m.bodyFetchedAt.toISOString() : null,
  };
}
