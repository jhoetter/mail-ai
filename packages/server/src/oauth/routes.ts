// HTTP routes for the OAuth-via-Nango onboarding flow.
//
// Flow:
//   1. UI calls POST /api/oauth/connect-session with { provider }.
//      We mint a Nango Connect Session token bound to that one
//      integration so the popup goes straight to Google or Microsoft.
//   2. UI uses @nangohq/frontend with that token to open the popup.
//      The popup gives back a connectionId on success.
//   3. UI calls POST /api/oauth/finalize with { provider, connectionId }.
//      We fetch the credentials from Nango once, persist them to
//      oauth_accounts, and return the AccountSummary.
//   4. From here on we never call Nango again — refreshes go directly
//      to the provider via @mailai/oauth-tokens.
//
// Demo mode: when NANGO_SECRET_KEY isn't set, the connect-session
// endpoint returns 503 with a structured error so the UI can show
// "Nango not configured" with a link to docs/oauth-setup.md.

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  OauthAccountsRepository,
  OauthMessagesRepository,
  OauthThreadStateRepository,
  OauthThreadTagsRepository,
  withTenant,
} from "@mailai/overlay-db";
import type { Pool } from "@mailai/overlay-db";
import {
  fetchGoogleUserInfo,
  fetchMicrosoftUserInfo,
  loadProviderCredentialsFromEnv,
  type ProviderCredentials,
} from "@mailai/oauth-tokens";
import { NangoClient } from "./nango-client.js";
import { syncOauthAccount } from "./sync.js";

export interface OauthRoutesDeps {
  readonly pool: Pool;
  readonly identity: (req: { headers: Record<string, unknown> }) => Promise<{
    userId: string;
    tenantId: string;
    email?: string;
    displayName?: string;
  }>;
  // Map of mail-ai provider key → Nango provider_config_key. Defaults
  // to Nango's standard template names. Override via env if your
  // Nango dashboard uses different keys.
  readonly nangoProviderKeys: { "google-mail": string; outlook: string };
  // Optional Nango client. When undefined we run in "demo mode": the
  // connect-session endpoint returns 503 with setup instructions.
  readonly nango?: NangoClient;
  // OAuth client credentials for direct token refresh + REST sync.
  // When omitted we read from env so existing callers don't break.
  readonly credentials?: ProviderCredentials;
}

const ProviderSchema = z.enum(["google-mail", "outlook"]);

const ConnectSessionBody = z.object({
  provider: ProviderSchema,
});

const FinalizeBody = z.object({
  provider: ProviderSchema,
  connectionId: z.string().min(1),
});

export function registerOauthRoutes(app: FastifyInstance, deps: OauthRoutesDeps): void {
  const credentials = deps.credentials ?? loadProviderCredentialsFromEnv();

  app.post("/api/oauth/connect-session", async (req, reply) => {
    const parsed = ConnectSessionBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation_error", details: parsed.error.format() });
    }
    if (!deps.nango) {
      return reply.code(503).send({
        error: "nango_not_configured",
        message:
          "NANGO_SECRET_KEY is not set on the server. See docs/oauth-setup.md for the 2-minute setup.",
        docs: "/docs/oauth-setup.md",
      });
    }
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const integrationKey = deps.nangoProviderKeys[parsed.data.provider];
    try {
      const session = await deps.nango.createConnectSession({
        endUser: {
          id: ident.userId,
          ...(ident.email ? { email: ident.email } : {}),
          ...(ident.displayName ? { displayName: ident.displayName } : {}),
        },
        allowedIntegrations: [integrationKey],
      });
      return {
        token: session.token,
        expiresAt: session.expiresAt,
        provider: parsed.data.provider,
        providerConfigKey: integrationKey,
      };
    } catch (err) {
      app.log.error({ err }, "nango connect-session failed");
      return reply.code(502).send({
        error: "nango_session_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post("/api/oauth/finalize", async (req, reply) => {
    const parsed = FinalizeBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation_error", details: parsed.error.format() });
    }
    if (!deps.nango) {
      return reply.code(503).send({ error: "nango_not_configured" });
    }
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const providerConfigKey = deps.nangoProviderKeys[parsed.data.provider];

    let conn;
    try {
      conn = await deps.nango.getConnection({
        connectionId: parsed.data.connectionId,
        providerConfigKey,
      });
    } catch (err) {
      app.log.error({ err }, "nango get-connection failed");
      return reply.code(502).send({
        error: "nango_get_connection_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    const creds = conn.credentials;
    if (creds.type !== "OAUTH2" || !creds.access_token) {
      return reply.code(400).send({
        error: "unexpected_credentials",
        message: `expected OAUTH2 credentials, got ${creds.type}`,
      });
    }

    // Resolve the *verified* mailbox address from the provider itself.
    // Nango sometimes stores it under connection_config.user_email but
    // not always (depends on which scopes are granted), and we never
    // want the UI to show `google-mail-<uuid>@unknown.local`. The
    // userinfo / Graph /me call is one HTTP round-trip and uses the
    // access token we just received, so it can't go stale.
    let resolvedEmail: string | null = null;
    try {
      if (parsed.data.provider === "google-mail") {
        const u = await fetchGoogleUserInfo({ accessToken: creds.access_token });
        resolvedEmail = u.email;
      } else {
        const u = await fetchMicrosoftUserInfo({ accessToken: creds.access_token });
        resolvedEmail = u.email;
      }
    } catch (err) {
      app.log.warn({ err }, "userinfo lookup failed; falling back to Nango fields");
    }

    const cfg = (conn.connection_config ?? {}) as Record<string, unknown>;
    const meta = (conn.metadata ?? {}) as Record<string, unknown>;
    const email =
      resolvedEmail ??
      asString(cfg["user_email"]) ??
      asString(meta["user_email"]) ??
      asString(cfg["email"]) ??
      asString(meta["email"]) ??
      `${parsed.data.provider}-${parsed.data.connectionId}@unknown.local`;

    const expiresAt = creds.expires_at ? new Date(creds.expires_at) : null;

    const saved = await withTenant(deps.pool, ident.tenantId, async (tx) => {
      const repo = new OauthAccountsRepository(tx);
      // If we resolved the real email this time around, evict any
      // leftover `<provider>-<connectionId>@unknown.local` placeholder
      // rows for this user so reconnecting heals the previous broken
      // state instead of producing two rows.
      if (resolvedEmail) {
        await repo.deletePlaceholders({
          tenantId: ident.tenantId,
          userId: ident.userId,
          provider: parsed.data.provider,
        });
      }
      return repo.upsert({
        id: `oa_${crypto.randomUUID()}`,
        tenantId: ident.tenantId,
        userId: ident.userId,
        provider: parsed.data.provider,
        email,
        accessToken: creds.access_token,
        refreshToken: creds.refresh_token ?? null,
        scope: creds.raw?.scope ?? null,
        expiresAt,
        nangoConnectionId: parsed.data.connectionId,
        nangoProviderConfigKey: providerConfigKey,
        rawJson: conn as unknown,
      });
    });

    // Kick off an initial sync so the inbox isn't empty when the user
    // returns from the OAuth popup. Best-effort: failures are recorded
    // in oauth_accounts.last_sync_error and exposed on /api/accounts;
    // the connect flow itself still succeeds. We await briefly (≤8s)
    // so the typical case shows mail immediately, then return.
    const syncPromise = withTenant(deps.pool, ident.tenantId, async (tx) => {
      const accounts = new OauthAccountsRepository(tx);
      const messages = new OauthMessagesRepository(tx);
      const fresh = await accounts.byId(ident.tenantId, saved.id);
      if (!fresh) return null;
      return syncOauthAccount(fresh, { accounts, messages, credentials });
    });
    let syncResult: Awaited<typeof syncPromise> | null = null;
    try {
      syncResult = await Promise.race([
        syncPromise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
      ]);
      if (syncResult === null) {
        // Hand off the slow path to the background; don't crash the
        // process if it eventually rejects.
        syncPromise.catch((err) => app.log.warn({ err }, "background initial sync failed"));
      }
    } catch (err) {
      app.log.warn({ err }, "initial sync failed; will be retryable from /api/accounts/:id/sync");
    }

    return {
      ...toSummary(saved, syncResult ? new Date() : saved.lastSyncedAt),
      initialSync: syncResult
        ? { status: "ok" as const, ...syncResult }
        : { status: "pending" as const },
    };
  });

  app.post("/api/accounts/:id/sync", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const { id } = req.params as { id: string };
    if (!id || !id.startsWith("oa_")) {
      return reply.code(400).send({ error: "bad_id" });
    }
    try {
      const result = await withTenant(deps.pool, ident.tenantId, async (tx) => {
        const accounts = new OauthAccountsRepository(tx);
        const messages = new OauthMessagesRepository(tx);
        const account = await accounts.byId(ident.tenantId, id);
        if (!account) return { notFound: true as const };
        const r = await syncOauthAccount(account, { accounts, messages, credentials });
        return { notFound: false as const, ...r };
      });
      if (result.notFound) {
        return reply.code(404).send({ error: "not_found" });
      }
      return result;
    } catch (err) {
      app.log.error({ err, accountId: id }, "manual sync failed");
      return reply.code(502).send({
        error: "sync_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get("/api/threads", async (req) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const q = (req.query as { limit?: string }) ?? {};
    const limit = q.limit ? Math.min(Math.max(Number(q.limit) || 100, 1), 500) : 100;
    const result = await withTenant(deps.pool, ident.tenantId, async (tx) => {
      const messages = new OauthMessagesRepository(tx);
      const threadTags = new OauthThreadTagsRepository(tx);
      const threadState = new OauthThreadStateRepository(tx);
      const rows = await messages.listByTenant(ident.tenantId, { limit });
      const providerThreadIds = Array.from(new Set(rows.map((m) => m.providerThreadId)));
      const tagsByThread = await threadTags.listForThreads(ident.tenantId, providerThreadIds);
      const stateByThread = await threadState.byUserAndThreads(
        ident.tenantId,
        ident.userId,
        providerThreadIds,
      );
      return { rows, tagsByThread, stateByThread };
    });
    return {
      threads: result.rows.map((m) => {
        const tags = result.tagsByThread.get(m.providerThreadId) ?? [];
        const state = result.stateByThread.get(m.providerThreadId);
        return {
          id: m.id,
          providerThreadId: m.providerThreadId,
          providerMessageId: m.providerMessageId,
          provider: m.provider,
          subject: m.subject ?? "(no subject)",
          from: m.fromName || m.fromEmail || "unknown",
          fromEmail: m.fromEmail,
          snippet: m.snippet,
          unread: m.unread,
          labels: m.labelsJson,
          date: m.internalDate.toISOString(),
          tags: tags.map((t) => ({ id: t.id, name: t.name, color: t.color })),
          status: state?.status ?? "open",
        };
      }),
    };
  });

  app.get("/api/accounts", async (req) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const rows = await withTenant(deps.pool, ident.tenantId, async (tx) => {
      const repo = new OauthAccountsRepository(tx);
      return repo.listByTenant(ident.tenantId);
    });
    return { accounts: rows.map((r) => toSummary(r, r.lastSyncedAt)) };
  });

  app.delete("/api/accounts/:id", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const { id } = req.params as { id: string };
    if (!id || !id.startsWith("oa_")) {
      return reply.code(400).send({ error: "bad_id" });
    }
    await withTenant(deps.pool, ident.tenantId, async (tx) => {
      const repo = new OauthAccountsRepository(tx);
      await repo.delete(ident.tenantId, id);
    });
    return { ok: true };
  });
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

interface AccountSummary {
  readonly id: string;
  readonly provider: string;
  readonly email: string;
  readonly status: string;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly lastSyncedAt: string | null;
  readonly lastSyncError: string | null;
}

function toSummary(
  row: {
    id: string;
    provider: string;
    email: string;
    status: string;
    expiresAt: Date | null;
    createdAt: Date;
    lastSyncError?: string | null;
  },
  lastSyncedAt: Date | null,
): AccountSummary {
  return {
    id: row.id,
    provider: row.provider,
    email: row.email,
    status: row.status,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    lastSyncedAt: lastSyncedAt ? lastSyncedAt.toISOString() : null,
    lastSyncError: row.lastSyncError ?? null,
  };
}
