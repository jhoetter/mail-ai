// Dev entry point. Boots fastify + ws on the same Node process.
// Production deployment usually splits these onto separate replicas,
// but for v1 single-process is enough.

import { WebSocketServer } from "ws";
import { CommandBus } from "@mailai/core";
import { AuditRepository, createPool, runMigrations, withTenant } from "@mailai/overlay-db";
import { loadProviderCredentialsFromEnv } from "@mailai/oauth-tokens";
import { buildApp } from "./app.js";
import { EventBroadcaster } from "./events.js";
import { NangoClient } from "./oauth/nango-client.js";
import {
  buildMailReplyHandler,
  buildMailSendHandler,
} from "./handlers/mail-send.js";
import {
  buildThreadAddTagHandler,
  buildThreadRemoveTagHandler,
} from "./handlers/thread-tags.js";
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

async function main() {

  const pool = createPool({
    connectionString:
      process.env["DATABASE_URL"] ??
      "postgres://mailai:mailai@localhost:5532/mailai",
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
  bus.register(
    "mail:send",
    buildMailSendHandler({ pool, tenantId: DEV_TENANT, credentials }),
  );
  bus.register(
    "mail:reply",
    buildMailReplyHandler({ pool, tenantId: DEV_TENANT, credentials }),
  );
  bus.register(
    "thread:add-tag",
    buildThreadAddTagHandler({ pool, tenantId: DEV_TENANT }),
  );
  bus.register(
    "thread:remove-tag",
    buildThreadRemoveTagHandler({ pool, tenantId: DEV_TENANT }),
  );
  bus.register(
    "thread:snooze",
    buildThreadSnoozeHandler({ pool, tenantId: DEV_TENANT }),
  );
  bus.register(
    "thread:unsnooze",
    buildThreadUnsnoozeHandler({ pool, tenantId: DEV_TENANT }),
  );
  bus.register(
    "thread:mark-done",
    buildThreadMarkDoneHandler({ pool, tenantId: DEV_TENANT }),
  );
  bus.register(
    "thread:reopen",
    buildThreadReopenHandler({ pool, tenantId: DEV_TENANT }),
  );
  bus.register(
    "draft:create",
    buildDraftCreateHandler({ pool, tenantId: DEV_TENANT, bus }),
  );
  bus.register(
    "draft:update",
    buildDraftUpdateHandler({ pool, tenantId: DEV_TENANT, bus }),
  );
  bus.register(
    "draft:delete",
    buildDraftDeleteHandler({ pool, tenantId: DEV_TENANT, bus }),
  );
  bus.register(
    "draft:send",
    buildDraftSendHandler({ pool, tenantId: DEV_TENANT, bus }),
  );
  bus.register(
    "calendar:create-event",
    buildCalendarCreateEventHandler({ pool, tenantId: DEV_TENANT, credentials }),
  );
  bus.register(
    "calendar:update-event",
    buildCalendarUpdateEventHandler({ pool, tenantId: DEV_TENANT, credentials }),
  );
  bus.register(
    "calendar:delete-event",
    buildCalendarDeleteEventHandler({ pool, tenantId: DEV_TENANT, credentials }),
  );
  bus.register(
    "calendar:respond",
    buildCalendarRespondHandler({ pool, tenantId: DEV_TENANT, credentials }),
  );
  // Best-effort: don't crash the server if Postgres isn't up (the dev
  // stack might be starting in parallel). OAuth routes will return 500
  // until migrations land — acceptable for dev, and explicit in logs.
  try {
    await runMigrations(pool);
    // Seed the dev tenant + user the stub identity returns. Uses
    // INSERT ... ON CONFLICT so it's idempotent across reboots and
    // safe alongside real tenants in shared databases.
    await pool.query(
      "INSERT INTO tenants(id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
      ["t_dev", "Dev Tenant"],
    );
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

  const app = buildApp({
    bus,
    broadcaster,
    // Stub identity: production uses JWT. Wire up in Phase 5.
    identity: async () => ({
      userId: "u_dev",
      tenantId: "t_dev",
      email: "dev@mail-ai.local",
      displayName: "Dev User",
    }),
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
  });

  const port = Number(process.env["API_PORT"] ?? process.env["PORT"] ?? 8200);
  const wsPort = Number(process.env["MAILAI_RT_PORT"] ?? 1235);

  await app.listen({ host: "0.0.0.0", port });
  const wss = new WebSocketServer({ port: wsPort });
  broadcaster.attach(wss);
  app.log.info(
    { port, wsPort, nango: !!nango },
    nango
      ? "mail-ai server listening (oauth ENABLED via Nango)"
      : "mail-ai server listening (oauth DEMO MODE — set NANGO_SECRET_KEY)",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
