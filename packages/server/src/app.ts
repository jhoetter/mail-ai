// Fastify app factory. The HTTP + WebSocket surface for mail-ai.
// All mutations route through the CommandBus instance the caller
// supplies — this file owns ZERO domain logic.

import Fastify, { type FastifyInstance } from "fastify";
import { CommandBus, type Command } from "@mailai/core";
import { CommandPayloadSchema } from "@mailai/agent";
import { loadProviderCredentialsFromEnv } from "@mailai/oauth-tokens";
import type { ObjectStore } from "@mailai/overlay-db";
import type {
  CalendarProviderRegistry,
  ContactsProviderRegistry,
  MailProviderRegistry,
} from "@mailai/providers";
import {
  buildCalendarProviderRegistry,
  buildContactsProviderRegistry,
  buildMailProviderRegistry,
} from "./providers.js";
import { EventBroadcaster, type MutationSubjectKind } from "./events.js";
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
import { registerWebhookRoutes } from "./routes/webhooks.js";
import type { SyncScheduler } from "./sync/scheduler.js";

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
  // Useful for tests that don't want a Postgres dep. The mail
  // provider registry is supplied by the app itself, so callers
  // don't have to pass it twice.
  readonly oauth?: Omit<OauthRoutesDeps, "identity" | "providers">;
  // Object storage for attachments + raw EML cache. Required for
  // /api/attachments and /api/messages/:id/raw.eml; mounted only when
  // present so test harnesses without S3 still work.
  readonly objectStore?: ObjectStore;
  // Mail provider registry. When omitted, we build a default
  // registry containing every adapter we ship — production wires
  // its own so test harnesses can stub adapters without a network.
  readonly providers?: MailProviderRegistry;
  // Calendar provider registry, same opt-out story as `providers`.
  readonly calendarProviders?: CalendarProviderRegistry;
  // Contacts provider registry, same opt-out story as `providers`.
  readonly contactsProviders?: ContactsProviderRegistry;
  // Scheduler used to react to push webhooks immediately. Optional
  // so test harnesses without a scheduler can still boot — webhook
  // routes are simply not mounted in that case.
  readonly scheduler?: SyncScheduler;
  // Tenants the webhook router will look subscriptions up in. v1 dev:
  // a single dev tenant. Required only when `scheduler` is supplied.
  readonly webhookTenants?: () => Promise<ReadonlyArray<string>>;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: true });
  const providers = deps.providers ?? buildMailProviderRegistry();
  const calendarProviders =
    deps.calendarProviders ?? buildCalendarProviderRegistry();
  const contactsProviders =
    deps.contactsProviders ?? buildContactsProviderRegistry();

  if (deps.oauth) {
    registerOauthRoutes(app, {
      ...deps.oauth,
      identity: deps.identity,
      providers,
    });
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
      providers,
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
      calendarProviders,
    });
    registerSignatureRoutes(app, {
      pool: deps.oauth.pool,
      identity: deps.identity,
    });
    registerContactsRoutes(app, {
      pool: deps.oauth.pool,
      identity: deps.identity,
      credentials: deps.oauth.credentials ?? loadProviderCredentialsFromEnv(),
      contactsProviders,
    });
    if (deps.scheduler && deps.webhookTenants) {
      registerWebhookRoutes(app, {
        pool: deps.oauth.pool,
        scheduler: deps.scheduler,
        tenants: deps.webhookTenants,
      });
    }
    if (deps.objectStore) {
      registerAttachmentRoutes(app, {
        pool: deps.oauth.pool,
        objectStore: deps.objectStore,
        credentials: deps.oauth.credentials ?? loadProviderCredentialsFromEnv(),
        providers,
        identity: deps.identity,
      });
      registerRawMessageRoutes(app, {
        pool: deps.oauth.pool,
        objectStore: deps.objectStore,
        credentials: deps.oauth.credentials ?? loadProviderCredentialsFromEnv(),
        providers,
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
      deps.broadcaster.publish({
        kind: "mutation",
        subjectKind: subjectKindForCommand(cmd.type),
        mutation: m,
      });
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

// Map a command type onto the realtime mutation envelope's
// `subjectKind` so the calendar UI (and only the calendar UI) reacts
// to event/calendar mutations. Kept narrow + total so a new command
// type forces a deliberate decision here.
function subjectKindForCommand(type: Command["type"]): MutationSubjectKind {
  if (type.startsWith("calendar:")) {
    return type === "calendar:create-event" ||
      type === "calendar:update-event" ||
      type === "calendar:delete-event" ||
      type === "calendar:respond"
      ? "event"
      : "calendar";
  }
  if (type.startsWith("thread:") || type.startsWith("inbox:")) return "thread";
  if (type.startsWith("comment:")) return "comment";
  if (type.startsWith("mail:") || type.startsWith("draft:") || type.startsWith("attachment:")) {
    return "message";
  }
  return "other";
}
