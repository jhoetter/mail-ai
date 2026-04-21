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
import { OauthAccountsRepository, withTenant } from "@mailai/overlay-db";
import type { Pool } from "@mailai/overlay-db";
import { NangoClient } from "./nango-client.js";

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

    // Best-effort email extraction. Nango stores the verified email
    // under connection_config.user_email for Google, or under
    // metadata.user_id for Microsoft. We fall back to connectionId so
    // the row is never anonymous.
    const cfg = (conn.connection_config ?? {}) as Record<string, unknown>;
    const meta = (conn.metadata ?? {}) as Record<string, unknown>;
    const email =
      asString(cfg["user_email"]) ??
      asString(meta["user_email"]) ??
      asString(cfg["email"]) ??
      asString(meta["email"]) ??
      `${parsed.data.provider}-${parsed.data.connectionId}@unknown.local`;

    const expiresAt = creds.expires_at ? new Date(creds.expires_at) : null;

    const saved = await withTenant(deps.pool, ident.tenantId, async (tx) => {
      const repo = new OauthAccountsRepository(tx);
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

    return toSummary(saved);
  });

  app.get("/api/accounts", async (req) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const rows = await withTenant(deps.pool, ident.tenantId, async (tx) => {
      const repo = new OauthAccountsRepository(tx);
      return repo.listByTenant(ident.tenantId);
    });
    return { accounts: rows.map(toSummary) };
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
}

function toSummary(row: {
  id: string;
  provider: string;
  email: string;
  status: string;
  expiresAt: Date | null;
  createdAt: Date;
}): AccountSummary {
  return {
    id: row.id,
    provider: row.provider,
    email: row.email,
    status: row.status,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
