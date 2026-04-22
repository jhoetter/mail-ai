// Views CRUD + view-scoped thread listing.
//
// `/api/views` returns the user's saved views (seeding the built-in
// defaults on first call). `/api/views/:id/threads` compiles a view's
// filter into a SQL predicate, runs it against oauth_messages joined
// with oauth_thread_state and oauth_thread_tags, and returns a thread
// summary list shaped like /api/threads. The Drafts and Sent built-ins
// short-circuit to their dedicated tables.

import type { FastifyInstance } from "fastify";
import {
  DraftsRepository,
  OauthAccountsRepository,
  OauthMessagesRepository,
  OauthThreadStateRepository,
  OauthThreadTagsRepository,
  ViewsRepository,
  withTenant,
  type OauthProvider,
  type Pool,
  type ViewFilter,
  type ViewRow,
} from "@mailai/overlay-db";

export interface ViewRoutesDeps {
  readonly pool: Pool;
  readonly identity: (req: { headers: Record<string, unknown> }) => Promise<{
    userId: string;
    tenantId: string;
  }>;
}

export function registerViewRoutes(app: FastifyInstance, deps: ViewRoutesDeps): void {
  app.get("/api/views", async (req) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    return withTenant(deps.pool, ident.tenantId, async (tx) => {
      const repo = new ViewsRepository(tx);
      const list = await repo.ensureBuiltinsForUser(ident.tenantId, ident.userId);
      return { views: list.map(toApi) };
    });
  });

  app.post("/api/views", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const body = req.body as
      | {
          name?: unknown;
          icon?: unknown;
          filter?: unknown;
          sortBy?: unknown;
          groupBy?: unknown;
        }
      | undefined;
    if (!body || typeof body.name !== "string" || body.name.trim().length === 0) {
      return reply.code(400).send({ error: "validation_error", message: "name required" });
    }
    return withTenant(deps.pool, ident.tenantId, async (tx) => {
      const repo = new ViewsRepository(tx);
      const existing = await repo.list(ident.tenantId, ident.userId);
      const id = `view_${ident.userId}_${slug(body.name as string)}_${Math.random().toString(36).slice(2, 8)}`;
      await repo.upsert({
        id,
        tenantId: ident.tenantId,
        userId: ident.userId,
        name: body.name as string,
        ...(typeof body.icon === "string" ? { icon: body.icon } : {}),
        position: existing.length,
        isBuiltin: false,
        filterJson: (body.filter as ViewFilter | undefined) ?? {},
        ...(typeof body.sortBy === "string" ? { sortBy: body.sortBy } : {}),
        ...(typeof body.groupBy === "string" ? { groupBy: body.groupBy } : {}),
      });
      const created = await repo.byId(ident.tenantId, ident.userId, id);
      return { view: created ? toApi(created) : null };
    });
  });

  app.patch("/api/views/:id", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const { id } = req.params as { id: string };
    const body = req.body as
      | {
          name?: unknown;
          icon?: unknown;
          filter?: unknown;
          sortBy?: unknown;
          groupBy?: unknown;
          position?: unknown;
        }
      | undefined;
    return withTenant(deps.pool, ident.tenantId, async (tx) => {
      const repo = new ViewsRepository(tx);
      const existing = await repo.byId(ident.tenantId, ident.userId, id);
      if (!existing) {
        return reply.code(404).send({ error: "not_found", message: `view ${id} not found` });
      }
      await repo.upsert({
        id: existing.id,
        tenantId: existing.tenantId,
        userId: existing.userId,
        name: typeof body?.name === "string" ? body.name : existing.name,
        icon: typeof body?.icon === "string" ? body.icon : existing.icon,
        position: typeof body?.position === "number" ? body.position : existing.position,
        isBuiltin: existing.isBuiltin,
        filterJson: (body?.filter as ViewFilter | undefined) ?? existing.filterJson,
        sortBy: typeof body?.sortBy === "string" ? body.sortBy : existing.sortBy,
        groupBy: typeof body?.groupBy === "string" ? body.groupBy : existing.groupBy,
        layout: existing.layout,
      });
      const updated = await repo.byId(ident.tenantId, ident.userId, id);
      return { view: updated ? toApi(updated) : null };
    });
  });

  app.delete("/api/views/:id", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const { id } = req.params as { id: string };
    return withTenant(deps.pool, ident.tenantId, async (tx) => {
      const repo = new ViewsRepository(tx);
      const existing = await repo.byId(ident.tenantId, ident.userId, id);
      if (!existing) {
        return reply.code(404).send({ error: "not_found", message: `view ${id} not found` });
      }
      if (existing.isBuiltin) {
        return reply
          .code(400)
          .send({ error: "validation_error", message: "built-in views cannot be deleted" });
      }
      await repo.delete(ident.tenantId, ident.userId, id);
      return { ok: true };
    });
  });

  // List threads visible inside a view. We do the filter compilation
  // in JS over the materialised oauth_messages table — at v1 scale
  // (a few thousand messages per user) this is faster to ship and
  // easier to audit than a SQL compiler. Once row counts justify it
  // we move the predicates into WHERE clauses.
  app.get("/api/views/:id/threads", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const { id } = req.params as { id: string };
    const limit = Math.min(
      Math.max(parseInt(((req.query as { limit?: string }).limit ?? "100"), 10) || 100, 1),
      500,
    );
    return withTenant(deps.pool, ident.tenantId, async (tx) => {
      const viewsRepo = new ViewsRepository(tx);
      const view = await viewsRepo.byId(ident.tenantId, ident.userId, id);
      if (!view) {
        return reply.code(404).send({ error: "not_found", message: `view ${id} not found` });
      }
      const filter = view.filterJson;

      // Drafts short-circuit: own table. Each draft carries the
      // oauth_account_id it was authored against; we resolve those
      // to the underlying provider so the row reports its true
      // origin instead of always claiming google-mail. This matters
      // the moment a user has both a Gmail and an Outlook connected
      // — the inbox icon, reply behaviour, and folder routing all
      // dispatch on `provider`.
      if (filter.kind === "drafts") {
        const draftsRepo = new DraftsRepository(tx);
        const list = await draftsRepo.listByUser(ident.tenantId, ident.userId, limit);
        const accountsRepo = new OauthAccountsRepository(tx);
        const accountIds = Array.from(
          new Set(list.map((d) => d.oauthAccountId).filter((id): id is string => !!id)),
        );
        const providerByAccount = new Map<string, OauthProvider>();
        for (const id of accountIds) {
          const acct = await accountsRepo.byId(ident.tenantId, id);
          if (acct) providerByAccount.set(id, acct.provider);
        }
        return {
          view: toApi(view),
          threads: list.map((d) => ({
            id: d.id,
            providerThreadId: d.providerThreadId ?? "",
            providerMessageId: "",
            // Fall through to google-mail only when the draft has
            // no account yet (it was started before pickAccount
            // ran). The composer always assigns one before save,
            // so this is rare and the value is harmless either way.
            provider:
              (d.oauthAccountId
                ? providerByAccount.get(d.oauthAccountId)
                : undefined) ?? "google-mail",
            subject: d.subject ?? "(no subject)",
            from: "you",
            fromEmail: null,
            snippet: (d.bodyText ?? d.bodyHtml ?? "").slice(0, 280),
            unread: false,
            // Drafts no longer carry a synthetic "DRAFT" label — the
            // status field below ("draft") is the authoritative
            // signal; the inbox renders a dedicated draft pill.
            labels: [] as string[],
            date: d.updatedAt.toISOString(),
            tags: [],
            status: "draft",
          })),
        };
      }

      // Wake any expired snoozes before reading. Tiny UPDATE; cheap
      // even on hot paths because it's bounded by the user's
      // outstanding snoozed-thread count.
      const stateRepo = new OauthThreadStateRepository(tx);
      await stateRepo.wakeUpExpired(ident.tenantId, ident.userId, new Date());

      const messagesRepo = new OauthMessagesRepository(tx);
      const all = await messagesRepo.listByTenant(ident.tenantId, { limit: 500 });

      // Build per-thread roll-up keyed by providerThreadId; we only
      // surface the latest message per thread to the inbox list.
      // Folder-scoped views (sent / trash / spam) roll up only over
      // messages already in that folder so a thread that lives in
      // both Inbox and Trash still appears in Trash.
      const folderScope: "sent" | "trash" | "spam" | null =
        filter.kind === "sent"
          ? "sent"
          : filter.kind === "trash"
            ? "trash"
            : filter.kind === "spam"
              ? "spam"
              : null;
      const folderFiltered = folderScope
        ? all.filter((m) => m.wellKnownFolder === folderScope)
        : all;
      const byThread = new Map<string, typeof all[number]>();
      for (const m of folderFiltered) {
        const existing = byThread.get(m.providerThreadId);
        if (!existing || m.internalDate.getTime() > existing.internalDate.getTime()) {
          byThread.set(m.providerThreadId, m);
        }
      }
      // Inbox-style views never want trash/spam noise leaking in; the
      // generic compiler should only ever see folders we present as
      // "main mail" — inbox + sent. Done/Snoozed/All operate on the
      // user's curated open conversations and intentionally include
      // sent items.
      let candidates = [...byThread.values()];
      if (!folderScope) {
        candidates = candidates.filter(
          (m) => m.wellKnownFolder !== "trash" && m.wellKnownFolder !== "spam",
        );
      }

      // Status filter via per-user thread state. We pre-load just the
      // states for the visible threads to avoid an N+1.
      const statusFilter = filter.status;
      if (statusFilter && statusFilter.length > 0) {
        const states = await Promise.all(
          candidates.map((m) =>
            stateRepo.get(ident.tenantId, ident.userId, m.providerThreadId),
          ),
        );
        candidates = candidates.filter((_, i) => {
          const s = states[i];
          const status = s?.status ?? "open";
          return statusFilter.includes(status as "open" | "snoozed" | "done");
        });
      }

      // Tag filters.
      if ((filter.tagsAny && filter.tagsAny.length > 0) ||
        (filter.tagsNone && filter.tagsNone.length > 0)) {
        const tagsRepo = new OauthThreadTagsRepository(tx);
        const tagsByThread = await tagsRepo.listForThreads(
          ident.tenantId,
          candidates.map((c) => c.providerThreadId),
        );
        if (filter.tagsAny && filter.tagsAny.length > 0) {
          const wanted = new Set(filter.tagsAny);
          candidates = candidates.filter((c) =>
            (tagsByThread.get(c.providerThreadId) ?? []).some((t) => wanted.has(t.id)),
          );
        }
        if (filter.tagsNone && filter.tagsNone.length > 0) {
          const banned = new Set(filter.tagsNone);
          candidates = candidates.filter((c) =>
            !(tagsByThread.get(c.providerThreadId) ?? []).some((t) => banned.has(t.id)),
          );
        }
      }

      if (filter.unread) candidates = candidates.filter((m) => m.unread);
      if (filter.fromContains) {
        const needle = filter.fromContains.toLowerCase();
        candidates = candidates.filter(
          (m) =>
            (m.fromEmail ?? "").toLowerCase().includes(needle) ||
            (m.fromName ?? "").toLowerCase().includes(needle),
        );
      }
      if (filter.accountIds && filter.accountIds.length > 0) {
        const allowed = new Set(filter.accountIds);
        candidates = candidates.filter((m) => allowed.has(m.oauthAccountId));
      }

      // Sort: only date_desc supported in v1. The schema lets us add
      // others without an API change.
      candidates.sort((a, b) => b.internalDate.getTime() - a.internalDate.getTime());
      const limited = candidates.slice(0, limit);

      // Hydrate tag chips for the visible rows in a single roundtrip.
      const tagsRepo = new OauthThreadTagsRepository(tx);
      const tagsByThread = await tagsRepo.listForThreads(
        ident.tenantId,
        limited.map((c) => c.providerThreadId),
      );

      return {
        view: toApi(view),
        threads: limited.map((m) => ({
          id: m.id,
          providerThreadId: m.providerThreadId,
          providerMessageId: m.providerMessageId,
          provider: m.provider,
          subject: m.subject ?? "(no subject)",
          from: m.fromName || m.fromEmail || "unknown",
          fromEmail: m.fromEmail,
          snippet: m.snippet,
          unread: m.unread,
          starred: m.starred,
          hasAttachments: m.hasAttachments,
          labels: m.labelsJson,
          date: m.internalDate.toISOString(),
          tags: (tagsByThread.get(m.providerThreadId) ?? []).map((t) => ({
            id: t.id,
            name: t.name,
            color: t.color,
          })),
        })),
      };
    });
  });
}

function toApi(v: ViewRow) {
  return {
    id: v.id,
    name: v.name,
    icon: v.icon,
    position: v.position,
    isBuiltin: v.isBuiltin,
    filter: v.filterJson,
    sortBy: v.sortBy,
    groupBy: v.groupBy,
    layout: v.layout,
  };
}

function slug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "view";
}
