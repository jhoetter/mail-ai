// Fastify app factory. The HTTP + WebSocket surface for mail-ai.
// All mutations route through the CommandBus instance the caller
// supplies — this file owns ZERO domain logic.

import Fastify, { type FastifyInstance } from "fastify";
import { CommandBus, type Command } from "@mailai/core";
import { CommandPayloadSchema } from "@mailai/agent";
import { loadProviderCredentialsFromEnv } from "@mailai/oauth-tokens";
import type { ObjectStore } from "@mailai/overlay-db";
import { EventBroadcaster } from "./events.js";
import { registerOauthRoutes, type OauthRoutesDeps } from "./oauth/routes.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerThreadRoutes } from "./routes/threads.js";
import { registerInboxRoutes } from "./routes/inboxes.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerTagRoutes } from "./routes/tags.js";
import { registerViewRoutes } from "./routes/views.js";
import { registerDraftRoutes } from "./routes/drafts.js";
import { registerCalendarRoutes } from "./routes/calendar.js";
import { registerAttachmentRoutes } from "./routes/attachments.js";
import { registerRawMessageRoutes } from "./routes/messages-raw.js";
import { registerSignatureRoutes } from "./routes/signatures.js";
import { registerContactsRoutes } from "./routes/contacts.js";

export interface AppDeps {
  readonly bus: CommandBus;
  readonly broadcaster: EventBroadcaster;
  readonly identity: (req: { headers: Record<string, unknown> }) => Promise<{
    userId: string;
    tenantId: string;
    email?: string;
    displayName?: string;
  }>;
  // Optional: when omitted, OAuth onboarding routes are NOT mounted.
  // Useful for tests that don't want a Postgres dep.
  readonly oauth?: Omit<OauthRoutesDeps, "identity">;
  // Object storage for attachments + raw EML cache. Required for
  // /api/attachments and /api/messages/:id/raw.eml; mounted only when
  // present so test harnesses without S3 still work.
  readonly objectStore?: ObjectStore;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: true });

  if (deps.oauth) {
    registerOauthRoutes(app, { ...deps.oauth, identity: deps.identity });
    // Search + thread detail share the same Postgres pool as OAuth
    // onboarding (they query oauth_messages). We mount them under the
    // same condition so test environments without a DB don't try to
    // wire them.
    registerSearchRoutes(app, { pool: deps.oauth.pool, identity: deps.identity });
    registerThreadRoutes(app, {
      pool: deps.oauth.pool,
      // Threads need to be able to refresh access tokens to fetch
      // bodies on demand. Fall back to env-loaded credentials so a
      // server started without explicit creds still serves cached
      // bodies (provider fetch will simply 401 and the row stays
      // empty, matching the pre-body behaviour).
      credentials: deps.oauth.credentials ?? loadProviderCredentialsFromEnv(),
      identity: deps.identity,
    });
    registerInboxRoutes(app, { pool: deps.oauth.pool, identity: deps.identity });
    registerAuditRoutes(app, { pool: deps.oauth.pool, identity: deps.identity });
    registerTagRoutes(app, { pool: deps.oauth.pool, identity: deps.identity });
    registerViewRoutes(app, { pool: deps.oauth.pool, identity: deps.identity });
    registerDraftRoutes(app, { pool: deps.oauth.pool, identity: deps.identity });
    registerCalendarRoutes(app, {
      pool: deps.oauth.pool,
      identity: deps.identity,
      credentials: deps.oauth.credentials ?? loadProviderCredentialsFromEnv(),
    });
    registerSignatureRoutes(app, {
      pool: deps.oauth.pool,
      identity: deps.identity,
    });
    registerContactsRoutes(app, {
      pool: deps.oauth.pool,
      identity: deps.identity,
      credentials: deps.oauth.credentials ?? loadProviderCredentialsFromEnv(),
    });
    if (deps.objectStore) {
      registerAttachmentRoutes(app, {
        pool: deps.oauth.pool,
        objectStore: deps.objectStore,
        credentials: deps.oauth.credentials ?? loadProviderCredentialsFromEnv(),
        identity: deps.identity,
      });
      registerRawMessageRoutes(app, {
        pool: deps.oauth.pool,
        objectStore: deps.objectStore,
        credentials: deps.oauth.credentials ?? loadProviderCredentialsFromEnv(),
        identity: deps.identity,
      });
    }
  }

  app.post("/api/commands", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const body = req.body as { commands: unknown[] } | unknown;
    const list = Array.isArray((body as { commands?: unknown[] }).commands)
      ? (body as { commands: unknown[] }).commands
      : [body];
    const headers = req.headers as Record<string, string | undefined>;
    const idempotencyKey = headers["idempotency-key"];
    const inboxId = headers["x-inbox-id"];
    const results = [];
    for (const raw of list) {
      const v = CommandPayloadSchema.safeParse(raw);
      if (!v.success) {
        return reply.code(400).send({ error: "validation_error", details: v.error.format() });
      }
      // The bus no longer treats "agent" source any differently from
      // "human" — staging was removed when /pending went away. We
      // still record the source for audit trails so we know later
      // whether a human or an agent issued the command.
      const source: Command["source"] = (headers["x-mailai-source"] as Command["source"]) ?? "human";
      const cmd: Command = {
        type: v.data.type,
        payload: v.data.payload,
        source,
        actorId: ident.userId,
        timestamp: Date.now(),
        sessionId: headers["x-session-id"] ?? crypto.randomUUID(),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      };
      const m = await deps.bus.dispatch(cmd, inboxId ? { inboxId } : {});
      results.push(m);
      deps.broadcaster.publish({ kind: "mutation", mutation: m });
    }
    return { results };
  });

  app.get("/api/whoami", async (req) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    return { userId: ident.userId, tenantId: ident.tenantId, displayName: "" };
  });

  app.get("/api/health", async () => ({ ok: true }));

  return app;
}
