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
  OauthAttachmentsRepository,
  OauthMessagesRepository,
  attachmentKeys,
  withTenant,
  type OauthAccountRow,
  type OauthAttachmentRow,
  type OauthMessageRow,
  type Pool,
} from "@mailai/overlay-db";
import { getValidAccessToken, type ProviderCredentials } from "@mailai/oauth-tokens";
import type { MailProviderRegistry, NormalizedAttachment } from "@mailai/providers";
import { randomId } from "@mailai/core";

export interface ThreadRoutesDeps {
  readonly pool: Pool;
  readonly credentials: ProviderCredentials;
  readonly providers: MailProviderRegistry;
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

    const attachmentsByMsg = await loadAttachments(deps, ident.tenantId, filled);
    const unreadCount = filled.filter((m) => m.unread).length;
    return {
      id: initial.root.id,
      subject: initial.root.subject ?? "(no subject)",
      providerThreadId: initial.root.providerThreadId,
      provider: initial.root.provider,
      unreadCount,
      messages: filled.map((m) => toMessage(m, attachmentsByMsg.get(m.id) ?? [])),
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
    const row = filled ?? m;
    const attachmentsByMsg = await loadAttachments(deps, ident.tenantId, [row]);
    return toMessage(row, attachmentsByMsg.get(row.id) ?? []);
  });
}

async function loadAttachments(
  deps: ThreadRoutesDeps,
  tenantId: string,
  rows: OauthMessageRow[],
): Promise<Map<string, OauthAttachmentRow[]>> {
  const out = new Map<string, OauthAttachmentRow[]>();
  if (rows.length === 0) return out;
  await withTenant(deps.pool, tenantId, async (tx) => {
    const repo = new OauthAttachmentsRepository(tx);
    for (const row of rows) {
      const list = await repo.listForMessage(tenantId, row.oauthAccountId, row.providerMessageId);
      out.set(row.id, list);
    }
  });
  return out;
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
        console.warn("[threads] failed to refresh token for body fetch", {
          accountId: aid,
          err: String(err),
        });
      }
    }
  });

  // Fetch in parallel, capped concurrency. The registry lookup
  // means this loop is provider-agnostic — adding IMAP later only
  // requires a new MailProvider implementation, not a new branch.
  interface Fetched {
    id: string;
    text: string | null;
    html: string | null;
    attachments: NormalizedAttachment[];
    providerMessageId: string;
    oauthAccountId: string;
  }
  const fetched: Fetched[] = await mapWithConcurrency(missing, 6, async (m) => {
    const tok = tokensByAccount.get(m.oauthAccountId);
    const base = {
      id: m.id,
      providerMessageId: m.providerMessageId,
      oauthAccountId: m.oauthAccountId,
    };
    if (!tok) {
      return { ...base, text: null, html: null, attachments: [] };
    }
    try {
      const body = await deps.providers.for(tok.account.provider).fetchMessageBody({
        accessToken: tok.accessToken,
        providerMessageId: m.providerMessageId,
      });
      return {
        ...base,
        text: body.text,
        html: body.html,
        attachments: [...body.attachments],
      };
    } catch {
      return { ...base, text: null, html: null, attachments: [] };
    }
  });

  // Persist body + attachment metadata in a single transaction. We
  // upsert one `oauth_attachments` row per part the provider returned
  // (no bytes yet — the actual download happens lazily when the
  // browser hits /api/attachments/:id).
  await withTenant(deps.pool, tenantId, async (tx) => {
    const repo = new OauthMessagesRepository(tx);
    const attRepo = new OauthAttachmentsRepository(tx);
    for (const r of fetched) {
      await repo.setBody(tenantId, r.id, { text: r.text, html: r.html });
      let hasAtts = false;
      for (const att of r.attachments) {
        const id = `att_${randomId()}`;
        const objectKey = attachmentKeys.accountMessageAtt(
          r.oauthAccountId,
          r.providerMessageId,
          id,
        );
        await attRepo.upsertForMessage({
          id,
          tenantId,
          oauthAccountId: r.oauthAccountId,
          providerMessageId: r.providerMessageId,
          providerAttachmentId: att.providerAttachmentId,
          objectKey,
          filename: att.filename.length > 0 ? att.filename : null,
          mime: att.mime,
          sizeBytes: att.sizeBytes,
          contentId: att.contentId,
          isInline: att.isInline,
        });
        hasAtts = true;
      }
      if (hasAtts) {
        await repo.setHasAttachments(tenantId, r.oauthAccountId, r.providerMessageId, true);
      }
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

function toMessage(m: OauthMessageRow, attachments: OauthAttachmentRow[]) {
  return {
    id: m.id,
    providerMessageId: m.providerMessageId,
    subject: m.subject,
    from: m.fromName || m.fromEmail || "unknown",
    fromName: m.fromName,
    fromEmail: m.fromEmail,
    to: m.toAddr,
    cc: m.ccAddr,
    bcc: m.bccAddr,
    date: m.internalDate.toISOString(),
    snippet: m.snippet,
    unread: m.unread,
    starred: m.starred,
    hasAttachments: m.hasAttachments,
    bodyText: m.bodyText,
    bodyHtml: m.bodyHtml,
    bodyFetchedAt: m.bodyFetchedAt ? m.bodyFetchedAt.toISOString() : null,
    attachments: attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      mime: a.mime,
      sizeBytes: a.sizeBytes,
      contentId: a.contentId,
      isInline: a.isInline,
    })),
  };
}
