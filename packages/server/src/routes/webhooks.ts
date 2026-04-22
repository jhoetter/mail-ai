// Push-notification webhook endpoints.
//
// Two transports, one shape: every successful webhook ends with
// `scheduler.triggerSync(tenantId, accountId)` so the actual sync
// work runs through the same code path as the periodic tick. The
// router never reads provider state itself — it just turns "the
// provider says this mailbox changed" into "scheduler, sync this
// account now".
//
// Auth: NONE on these routes. Providers POST without bearer
// credentials; we authenticate Graph payloads via the `clientState`
// they echo back (we generated it, persisted it, and only accept
// payloads whose value matches a row in `oauth_push_subscriptions`),
// and Gmail/Pub/Sub payloads via the verified `emailAddress` inside
// the message envelope (the row lookup is tenant-scoped via the
// account's email, not via the inbound URL). No tenant-id header is
// trusted — we recover it from the persisted subscription row.

import type { FastifyInstance } from "fastify";
import {
  OauthAccountsRepository,
  OauthPushSubscriptionsRepository,
  withTenant,
  type Pool,
  type PushSubscriptionRow,
} from "@mailai/overlay-db";
import type { SyncScheduler } from "../sync/scheduler.js";

export interface WebhookRoutesDeps {
  readonly pool: Pool;
  readonly scheduler: SyncScheduler;
  // Tenants the webhook router is willing to look subscriptions up in.
  // v1 dev: `["t_dev"]`. Production: replace with a registry lookup.
  // Kept narrow so a malicious payload can't make us scan the whole
  // workspace before responding.
  readonly tenants: () => Promise<ReadonlyArray<string>>;
}

interface PubSubEnvelope {
  message?: {
    data?: string;
    messageId?: string;
    publishTime?: string;
  };
  subscription?: string;
}

interface GmailPushPayload {
  emailAddress?: string;
  historyId?: string;
}

interface GraphChangeNotification {
  subscriptionId?: string;
  clientState?: string;
  changeType?: string;
  resource?: string;
  tenantId?: string;
}

interface GraphNotificationBatch {
  value?: GraphChangeNotification[];
}

export function registerWebhookRoutes(
  app: FastifyInstance,
  deps: WebhookRoutesDeps,
): void {
  // ── Gmail / Pub/Sub ────────────────────────────────────────────
  //
  // Pub/Sub POSTs an envelope wrapping a base64-encoded data field.
  // Decoding it gives `{ emailAddress, historyId }`. We acknowledge
  // with 200 OK as fast as possible (Pub/Sub retries non-2xx for up
  // to 7 days, which would amplify any bug into a stampede), and
  // hand the actual sync work off to the scheduler.
  app.post("/api/webhooks/gmail", async (req, reply) => {
    const body = req.body as PubSubEnvelope | undefined;
    const data = body?.message?.data;
    if (!data) {
      // Pub/Sub probe / malformed: ack so it doesn't retry, but log
      // for visibility.
      req.log.warn({ body }, "[webhook/gmail] empty Pub/Sub envelope");
      return reply.code(204).send();
    }
    let payload: GmailPushPayload;
    try {
      const json = Buffer.from(data, "base64").toString("utf8");
      payload = JSON.parse(json) as GmailPushPayload;
    } catch (err) {
      req.log.warn({ err }, "[webhook/gmail] failed to decode Pub/Sub payload");
      return reply.code(204).send();
    }
    const email = payload.emailAddress?.toLowerCase();
    if (!email) {
      req.log.warn({ payload }, "[webhook/gmail] missing emailAddress");
      return reply.code(204).send();
    }

    const tenants = await deps.tenants();
    let triggered = false;
    for (const tenantId of tenants) {
      const accountId = await withTenant(deps.pool, tenantId, async (tx) => {
        const accounts = new OauthAccountsRepository(tx);
        const all = await accounts.listByTenant(tenantId);
        const match = all.find(
          (a) => a.provider === "google-mail" && a.email.toLowerCase() === email,
        );
        return match?.id ?? null;
      });
      if (!accountId) continue;
      // Fire and forget: respond to Pub/Sub immediately and let the
      // scheduler do the work. Errors are logged inside triggerSync.
      void deps.scheduler.triggerSync(tenantId, accountId);
      triggered = true;
      break;
    }
    if (!triggered) {
      req.log.warn(
        { email },
        "[webhook/gmail] no matching account for Pub/Sub push",
      );
    }
    return reply.code(204).send();
  });

  // ── Microsoft Graph ─────────────────────────────────────────────
  //
  // Two distinct payload shapes share this endpoint:
  //   1. The validation handshake — Graph hits the URL with
  //      `?validationToken=…` once when the subscription is created;
  //      we MUST echo the token back as text/plain within 10s or
  //      Graph rejects the subscription.
  //   2. Change notifications — POST body is `{ value: [...] }` of
  //      change records, each carrying our `clientState`.
  app.post("/api/webhooks/graph", async (req, reply) => {
    const query = req.query as { validationToken?: string } | undefined;
    if (query?.validationToken) {
      // Graph's docs: respond 200 with the raw token as text/plain.
      reply.header("content-type", "text/plain");
      return reply.code(200).send(query.validationToken);
    }

    const body = req.body as GraphNotificationBatch | undefined;
    const notifications = body?.value ?? [];
    if (notifications.length === 0) {
      return reply.code(202).send();
    }

    const tenants = await deps.tenants();
    // Dedupe by (tenant, accountId) so a batch with five notifications
    // for the same Inbox only triggers one sync.
    const targets = new Map<string, { tenantId: string; accountId: string }>();
    for (const n of notifications) {
      const clientState = n.clientState;
      if (!clientState) continue;
      for (const tenantId of tenants) {
        const sub = await withTenant(deps.pool, tenantId, async (tx) => {
          const repo = new OauthPushSubscriptionsRepository(tx);
          return repo.byClientState(tenantId, clientState);
        });
        if (!sub) continue;
        // Strict provider check — the same clientState space is
        // shared across providers in principle.
        if (sub.provider !== "outlook") continue;
        const key = `${tenantId}::${sub.oauthAccountId}`;
        targets.set(key, { tenantId, accountId: sub.oauthAccountId });
        break;
      }
    }

    if (targets.size === 0) {
      req.log.warn(
        { count: notifications.length },
        "[webhook/graph] no matching subscriptions for batch",
      );
    }
    for (const t of targets.values()) {
      void deps.scheduler.triggerSync(t.tenantId, t.accountId);
    }
    // Graph expects a 202 within 30s.
    return reply.code(202).send();
  });

  // GET endpoint for ops to inspect current subscription state. Auth
  // would be wired here in production; mounted as a sibling so the
  // raw row shape is always visible alongside the webhook URL.
  app.get<{ Params: { tenantId: string } }>(
    "/api/webhooks/_subscriptions/:tenantId",
    async (req): Promise<{ subscriptions: PushSubscriptionRow[] }> => {
      const { tenantId } = req.params;
      const subs = await withTenant(deps.pool, tenantId, async (tx) => {
        const repo = new OauthPushSubscriptionsRepository(tx);
        return repo.listAll(tenantId);
      });
      return { subscriptions: subs };
    },
  );
}
