// Dev entry point. Boots fastify + ws on the same Node process.
// Production deployment usually splits these onto separate replicas,
// but for v1 single-process is enough.

import { loadWorkspaceDotenv } from "./env-bootstrap.js";
// Must run before any module reads process.env (e.g. credentials,
// S3 config below) so `pnpm dev` picks up `.env` the same way `make
// dev` does. Existing shell env always wins.
loadWorkspaceDotenv();

import { WebSocketServer } from "ws";
import { CommandBus } from "@mailai/core";
import {
  AuditRepository,
  InMemoryObjectStore,
  S3ObjectStore,
  withKeyPrefix,
  createPool,
  loadS3OptionsFromEnv,
  runMigrations,
  withTenant,
  type ObjectStore,
} from "@mailai/overlay-db";
import { loadProviderCredentialsFromEnv } from "@mailai/oauth-tokens";
import { buildApp } from "./app.js";
import {
  buildCalendarProviderRegistry,
  buildMailProviderRegistry,
  buildPushProviderRegistry,
} from "./providers.js";
import { EventBroadcaster } from "./events.js";
import { NangoClient } from "./oauth/nango-client.js";
import {
  buildMailForwardHandler,
  buildMailMarkReadHandler,
  buildMailMarkUnreadHandler,
  buildMailReplyHandler,
  buildMailSendHandler,
  buildMailStarHandler,
} from "./handlers/mail-send.js";
import {
  buildAttachmentRemoveHandler,
  buildAttachmentUploadFinaliseHandler,
  buildAttachmentUploadInitHandler,
} from "./handlers/attachments.js";
import { buildAccountSetSignatureHandler } from "./handlers/account-signature.js";
import { buildThreadAddTagHandler, buildThreadRemoveTagHandler } from "./handlers/thread-tags.js";
import {
  buildThreadMarkDoneHandler,
  buildThreadReopenHandler,
  buildThreadSnoozeHandler,
  buildThreadUnsnoozeHandler,
} from "./handlers/thread-state.js";
import {
  buildDraftCreateHandler,
  buildDraftDeleteHandler,
  buildDraftSendHandler,
  buildDraftUpdateHandler,
} from "./handlers/drafts.js";
import {
  buildCalendarCreateEventHandler,
  buildCalendarDeleteEventHandler,
  buildCalendarRespondHandler,
  buildCalendarUpdateEventHandler,
} from "./handlers/calendar.js";
import { SyncScheduler } from "./sync/scheduler.js";
import { buildHofJwtIdentity, type ResolvedIdentity } from "./auth/hof-jwt.js";

async function main() {
  const pool = createPool({
    connectionString:
      process.env["DATABASE_URL"] ?? "postgres://mailai:mailai@localhost:5532/mailai",
  });
  // Single dev tenant for now — production will derive this from the
  // authenticated identity. Audit fan-out runs inside a tenant tx so
  // RLS sees the right tenant_id for inserts.
  const DEV_TENANT = "t_dev";

  const broadcaster = new EventBroadcaster();
  const bus = new CommandBus({
    audit: async (mutation) => {
      try {
        await withTenant(pool, DEV_TENANT, (tx) => {
          const repo = new AuditRepository(tx);
          return repo.append(DEV_TENANT, mutation);
        });
      } catch (err) {
        // The audit log is the durable copy; failure to record is a
        // serious operational issue. We log and continue rather than
        // failing the mutation — the in-memory mutation store still
        // has the row, so the operator can retry-apply once the DB
        // recovers without losing the request.
        console.error("audit append failed:", err);
      }
    },
  });

  const credentials = loadProviderCredentialsFromEnv();
  const providers = buildMailProviderRegistry();
  const calendarProviders = buildCalendarProviderRegistry();

  // Object storage. Falls back to an in-memory store so test
  // environments without MinIO/S3 can still boot the server (presigned
  // URL paths will fail loudly when the composer tries to upload).
  const s3Opts = loadS3OptionsFromEnv();
  let objectStore: ObjectStore;
  if (s3Opts) {
    const s3 = new S3ObjectStore(s3Opts);
    try {
      await s3.ensureBucket();
    } catch (err) {
      console.warn("warning: S3 bucket bootstrap failed (continuing):", err);
    }
    objectStore = s3;
  } else {
    console.warn("S3_* env vars not set; using InMemoryObjectStore — presigned URLs will not work");
    objectStore = new InMemoryObjectStore();
  }
  // When mail-ai runs as a hof-os sidecar, the data-app injects
  // `S3_KEY_PREFIX=tenants/<t>/mail` so all attachments live under the
  // cell's tenant root and the data-app can re-validate them via
  // `ensure_key_under_tenant_prefix`. Standalone `pnpm dev` leaves the
  // env unset and the wrapper becomes a no-op.
  objectStore = withKeyPrefix(objectStore, process.env["S3_KEY_PREFIX"] ?? null);

  const mailSendDeps = {
    pool,
    tenantId: DEV_TENANT,
    credentials,
    objectStore,
    providers,
  };
  bus.register("mail:send", buildMailSendHandler(mailSendDeps));
  bus.register("mail:reply", buildMailReplyHandler(mailSendDeps));
  bus.register("mail:forward", buildMailForwardHandler(mailSendDeps));
  bus.register("mail:mark-read", buildMailMarkReadHandler(mailSendDeps));
  bus.register("mail:mark-unread", buildMailMarkUnreadHandler(mailSendDeps));
  bus.register("mail:star", buildMailStarHandler(mailSendDeps));
  bus.register(
    "attachment:upload-init",
    buildAttachmentUploadInitHandler({ pool, tenantId: DEV_TENANT, objectStore }),
  );
  bus.register(
    "attachment:upload-finalise",
    buildAttachmentUploadFinaliseHandler({ pool, tenantId: DEV_TENANT, objectStore }),
  );
  bus.register(
    "attachment:remove",
    buildAttachmentRemoveHandler({ pool, tenantId: DEV_TENANT, objectStore }),
  );
  bus.register(
    "account:set-signature",
    buildAccountSetSignatureHandler({ pool, tenantId: DEV_TENANT }),
  );
  bus.register("thread:add-tag", buildThreadAddTagHandler({ pool, tenantId: DEV_TENANT }));
  bus.register("thread:remove-tag", buildThreadRemoveTagHandler({ pool, tenantId: DEV_TENANT }));
  bus.register("thread:snooze", buildThreadSnoozeHandler({ pool, tenantId: DEV_TENANT }));
  bus.register("thread:unsnooze", buildThreadUnsnoozeHandler({ pool, tenantId: DEV_TENANT }));
  bus.register("thread:mark-done", buildThreadMarkDoneHandler({ pool, tenantId: DEV_TENANT }));
  bus.register("thread:reopen", buildThreadReopenHandler({ pool, tenantId: DEV_TENANT }));
  bus.register("draft:create", buildDraftCreateHandler({ pool, tenantId: DEV_TENANT, bus }));
  bus.register("draft:update", buildDraftUpdateHandler({ pool, tenantId: DEV_TENANT, bus }));
  bus.register("draft:delete", buildDraftDeleteHandler({ pool, tenantId: DEV_TENANT, bus }));
  bus.register("draft:send", buildDraftSendHandler({ pool, tenantId: DEV_TENANT, bus }));
  const calendarDeps = {
    pool,
    tenantId: DEV_TENANT,
    credentials,
    calendarProviders,
    mailProviders: providers,
  };
  bus.register("calendar:create-event", buildCalendarCreateEventHandler(calendarDeps));
  bus.register("calendar:update-event", buildCalendarUpdateEventHandler(calendarDeps));
  bus.register("calendar:delete-event", buildCalendarDeleteEventHandler(calendarDeps));
  bus.register("calendar:respond", buildCalendarRespondHandler(calendarDeps));
  // Best-effort: don't crash the server if Postgres isn't up (the dev
  // stack might be starting in parallel). OAuth routes will return 500
  // until migrations land — acceptable for dev, and explicit in logs.
  try {
    await runMigrations(pool);
    // Seed the dev tenant + user the stub identity returns. Uses
    // INSERT ... ON CONFLICT so it's idempotent across reboots and
    // safe alongside real tenants in shared databases.
    await pool.query("INSERT INTO tenants(id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [
      "t_dev",
      "Dev Tenant",
    ]);
    await pool.query(
      "INSERT INTO users(id, tenant_id, email, display_name, role) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING",
      ["u_dev", "t_dev", "dev@mail-ai.local", "Dev User", "admin"],
    );
  } catch (err) {
    console.error("warning: migrations/seed failed (continuing):", err);
  }

  const nangoSecret = process.env["NANGO_SECRET_KEY"];
  const nangoHost = process.env["NANGO_HOST"] ?? "https://api.nango.dev";
  const nango = nangoSecret
    ? new NangoClient({ secretKey: nangoSecret, host: nangoHost })
    : undefined;

  // Background sync scheduler is built before the HTTP app so the
  // webhook routes can be mounted with a triggerSync callback wired
  // through the same code path the periodic tick uses. The scheduler
  // is `start()`ed below, after the app starts listening, so the
  // first tick doesn't fight the boot path for connection slots.
  const syncDisabled = process.env["MAILAI_SYNC_DISABLED"] === "1";
  const isProd = process.env["NODE_ENV"] === "production";
  const baseIntervalMs = Number(
    process.env["MAILAI_SYNC_INTERVAL_MS"] ?? (isProd ? 300_000 : 60_000),
  );
  const tickIntervalMs = Math.max(15_000, Math.floor(baseIntervalMs / 2));

  // Push subscription config. Both env vars are optional — when
  // missing for a provider the scheduler simply skips push for that
  // provider, falling back to the periodic poll. Gmail's value is
  // the fully-qualified Pub/Sub topic; Graph's is the public HTTPS
  // webhook URL exposed by /api/webhooks/graph.
  // Per-provider notification destinations. Adding a third provider
  // means appending one more env-derived entry; the lookup below
  // stays a Map.get so the scheduler never needs to branch on
  // provider id. Missing entries mean "push not configured for this
  // provider — fall back to polling".
  const pushDestinations = new Map<string, string | null>([
    ["google-mail", process.env["MAILAI_PUSH_GMAIL_TOPIC"] ?? null],
    ["outlook", process.env["MAILAI_PUSH_GRAPH_WEBHOOK_URL"] ?? null],
  ]);
  const pushEnabled = [...pushDestinations.values()].some((v) => v != null);
  const pushConfig = pushEnabled
    ? {
        registry: buildPushProviderRegistry(),
        notificationUrlFor: (provider: string) => pushDestinations.get(provider) ?? null,
      }
    : null;

  const scheduler = syncDisabled
    ? null
    : new SyncScheduler({
        pool,
        credentials,
        providers,
        broadcaster,
        // v1 dev only knows about the seed tenant. When real auth lands
        // this becomes a SELECT DISTINCT tenant_id FROM oauth_accounts
        // (or a registry table) so every workspace gets swept.
        tenants: async () => [DEV_TENANT],
        baseIntervalMs,
        tickIntervalMs,
        ...(pushConfig ? { push: pushConfig } : {}),
      });

  const app = buildApp({
    bus,
    broadcaster,
    // Identity resolver. When `HOF_SUBAPP_JWT_SECRET` is set (the
    // hof-os–embedded deployment), this requires a Bearer JWT issued
    // by hof-os' `issue_subapp_token` @function and rejects requests
    // without one. When it's unset (`make dev`), it returns the dev
    // stub identity so local development keeps working unchanged.
    // The identity resolver wraps `buildHofJwtIdentity` with a one-shot
    // upsert: when hof-os mints a JWT for a tenant/user we've never
    // seen (the embed's host workspace + actor), we INSERT them
    // idempotently into `tenants` + `users` so foreign-key constraints
    // and RLS policies don't reject the very first request from a
    // freshly provisioned customer cell. The cache keeps the hot path
    // a single hashmap hit per request.
    identity: wrapIdentityWithUpsert(
      buildHofJwtIdentity({
        fallback: {
          userId: "u_dev",
          tenantId: "t_dev",
          email: "dev@mail-ai.local",
          displayName: "Dev User",
        },
        expectedAudience: "mailai",
      }),
      pool,
    ),
    oauth: {
      pool,
      nangoProviderKeys: {
        "google-mail": process.env["NANGO_GOOGLE_INTEGRATION"] ?? "google-mail",
        outlook: process.env["NANGO_OUTLOOK_INTEGRATION"] ?? "outlook",
      },
      // Provider client credentials for direct refresh / REST sync.
      // Empty object is fine — sync routes will surface a clear
      // "no GOOGLE_OAUTH_CLIENT_ID" auth_error in that case.
      credentials,
      ...(nango ? { nango } : {}),
    },
    objectStore,
    ...(scheduler
      ? {
          scheduler,
          webhookTenants: async () => [DEV_TENANT],
        }
      : {}),
  });

  const port = Number(process.env["API_PORT"] ?? process.env["PORT"] ?? 8200);
  // Legacy: a separate WS port was the default (1235). Embedded
  // deployments (hof-os) can't proxy a second arbitrary port through
  // the data-app's /api/mail/ws prefix, so the new default is to
  // merge the WSS onto the Fastify HTTP server via an upgrade
  // handler at /ws (same-origin, single-port, proxy-friendly).
  // Operators who explicitly set MAILAI_RT_PORT keep the old
  // behaviour — handy for split-process production deployments where
  // the realtime tier scales independently of the HTTP API.
  const explicitWsPort = process.env["MAILAI_RT_PORT"];
  const wsMode: "merged" | "separate" = explicitWsPort ? "separate" : "merged";

  await app.listen({ host: "0.0.0.0", port });

  let wss: WebSocketServer;
  let wsPort: number | null = null;
  if (wsMode === "separate") {
    wsPort = Number(explicitWsPort);
    wss = new WebSocketServer({ port: wsPort });
  } else {
    // Mounted on the same port the HTTP API already binds. Path
    // gating keeps any future routes (or stray probes) from being
    // upgraded — only `/ws` becomes a WebSocket; everything else
    // gets the socket destroyed so Fastify's normal 404 path is
    // not triggered with a half-upgraded request.
    wss = new WebSocketServer({ noServer: true });
    app.server.on("upgrade", (req, socket, head) => {
      const reqUrl = req.url ?? "/";
      const pathname = reqUrl.split("?", 1)[0] ?? "/";
      if (pathname !== "/ws") {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    });
  }
  broadcaster.attach(wss);
  app.log.info(
    { port, wsPort, wsMode, nango: !!nango },
    nango
      ? `mail-ai server listening (ws=${wsMode}, oauth ENABLED via Nango)`
      : `mail-ai server listening (ws=${wsMode}, oauth DEMO MODE — set NANGO_SECRET_KEY)`,
  );

  // Background sync. Disabled with MAILAI_SYNC_DISABLED=1 (handy for
  // running the API in a debugger without unrelated provider chatter
  // in the logs). Interval is configurable via MAILAI_SYNC_INTERVAL_MS;
  // defaults to 60s in dev, 300s for prod-like NODE_ENV.
  if (scheduler) {
    scheduler.start();
    const shutdown = async (sig: string) => {
      app.log.info({ sig }, "shutting down sync scheduler");
      try {
        await scheduler.stop();
      } catch (err) {
        app.log.warn({ err }, "scheduler stop failed");
      }
    };
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    process.once("SIGINT", () => void shutdown("SIGINT"));
  } else {
    app.log.info("background sync DISABLED via MAILAI_SYNC_DISABLED=1");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Wrap an identity resolver so that the first time we see a given
 * (tenantId, userId) pair from a JWT, we upsert the corresponding
 * rows into `tenants` and `users`. Idempotent ON CONFLICT DO NOTHING
 * inserts run inside a single short transaction; subsequent requests
 * for the same identity hit the in-process Set cache and skip the DB
 * roundtrip entirely.
 *
 * The dev fallback (`u_dev`/`t_dev`) is already seeded by the boot
 * path, so the cache is pre-warmed below to avoid a redundant insert
 * on every standalone `pnpm dev` request.
 */
function wrapIdentityWithUpsert(
  inner: (req: { headers: Record<string, unknown> }) => Promise<ResolvedIdentity>,
  pool: import("@mailai/overlay-db").Pool,
): (req: { headers: Record<string, unknown> }) => Promise<ResolvedIdentity> {
  const seen = new Set<string>(["t_dev|u_dev"]);
  return async (req) => {
    const ident = await inner(req);
    const key = `${ident.tenantId}|${ident.userId}`;
    if (seen.has(key)) return ident;
    try {
      // Tenants first (users.tenant_id has a FK to tenants.id), then
      // users. Both inserts swallow the duplicate so a parallel
      // request can win the race without retry.
      await pool.query(
        "INSERT INTO tenants(id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
        [ident.tenantId, ident.tenantId],
      );
      await pool.query(
        "INSERT INTO users(id, tenant_id, email, display_name, role) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING",
        [
          ident.userId,
          ident.tenantId,
          ident.email ?? `${ident.userId}@hof-os.local`,
          ident.displayName ?? ident.userId,
          "admin",
        ],
      );
      seen.add(key);
    } catch (err) {
      // Don't block the request — log + retry on the next call. The
      // request handler may still 500 if a downstream FK rejects, but
      // that's clearer to debug than silently corrupt the cache.
      console.warn("[identity] upsert failed; will retry next request", { ident, err });
    }
    return ident;
  };
}
