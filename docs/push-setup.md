# Push notifications (Phase 7)

mail-ai polls every connected mailbox every 60s in dev and every 5
minutes in production. That latency is fine for a 1-person inbox but
visibly slow for shared inboxes — push notifications close the gap by
letting the provider tell us "this mailbox just changed". The
`SyncScheduler` reacts immediately, runs an out-of-band `pullDelta`,
and broadcasts a `sync` event so connected web clients refresh.

This document covers operator setup. The application code (adapters,
scheduler renewals, webhook routes) is already wired — the only
choice you have is whether to enable push for Gmail, Graph, both, or
neither.

---

## TL;DR

- Push is **opt-in per provider**. If you don't set the env var, the
  scheduler falls back to polling for that provider.
- The `SyncScheduler` subscribes new accounts on first sight and
  renews subscriptions before they expire. There is no separate
  "subscribe my mailbox" button.
- Webhook routes are mounted at `/api/webhooks/gmail` and
  `/api/webhooks/graph` and require **no auth**. Trust comes from the
  per-subscription `clientState` we generate (Graph) and from the
  verified `emailAddress` Pub/Sub puts inside the message envelope
  (Gmail).

---

## Gmail (Cloud Pub/Sub)

Gmail's `users.watch` API doesn't POST to your URL directly. It
publishes a tiny `{ emailAddress, historyId }` message to a Cloud
Pub/Sub topic; you configure a Pub/Sub **push subscription** on that
topic that POSTs to mail-ai. So you need three things in Google Cloud:

1. **A Pub/Sub topic** for Gmail to publish into.
2. **An IAM grant** so Gmail's service account can publish to it.
3. **A Pub/Sub push subscription** that POSTs to your mail-ai
   webhook.

### Step-by-step

1. Pick a project (or create one). The project must have the Gmail
   API and Cloud Pub/Sub API enabled.

2. Create the topic:

   ```sh
   gcloud pubsub topics create mailai-gmail \
     --project=<your-project>
   ```

3. Grant Gmail permission to publish to it. Gmail's publisher
   service account is the same for all customers:

   ```sh
   gcloud pubsub topics add-iam-policy-binding mailai-gmail \
     --project=<your-project> \
     --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
     --role=roles/pubsub.publisher
   ```

4. Create a push subscription that POSTs to mail-ai. Replace
   `https://api.example.com` with the externally-reachable origin of
   your API server.

   ```sh
   gcloud pubsub subscriptions create mailai-gmail-push \
     --project=<your-project> \
     --topic=mailai-gmail \
     --push-endpoint=https://api.example.com/api/webhooks/gmail \
     --ack-deadline=10
   ```

   Pub/Sub retries failed deliveries for up to 7 days. The webhook
   route ACKs every payload (`204` for success, `204` for malformed)
   so a misbehaving sync doesn't accumulate retries. Only "real"
   network errors leave the message unacked.

5. Set the env var on the API server and restart:

   ```sh
   export MAILAI_PUSH_GMAIL_TOPIC=projects/<your-project>/topics/mailai-gmail
   ```

6. Verify. After ~30s the scheduler picks up healthy Gmail accounts
   and registers `users.watch`. Send yourself an email — within a
   few seconds the Inbox view in mail-ai should refresh without you
   touching anything. Check the server logs for
   `[sync-scheduler] push subscription updated`.

### Lifetime

`users.watch` lasts 7 days. The scheduler renews 24h before expiry,
which means a 24h scheduler outage is tolerable. Past that, the
subscription lapses; the next scheduler tick re-subscribes
automatically. No manual intervention is needed for normal
operations.

### Removing push

Unset `MAILAI_PUSH_GMAIL_TOPIC` and restart. Existing subscriptions
will lapse on their own within 7 days. To unsubscribe immediately,
delete the rows from `oauth_push_subscriptions` and call
`users.stop` against each Google account (the scheduler doesn't do
this automatically — the assumption is "operator turned push off,
operator owns cleanup").

---

## Microsoft Graph

Graph posts directly to a public HTTPS URL. There is no Pub/Sub
intermediary; the URL itself is the contract.

### Requirements

- The webhook URL must be reachable from the public internet over
  HTTPS. Self-signed certs do NOT work — Graph requires a publicly
  trusted CA.
- The URL must answer the **validation handshake** within 10
  seconds. mail-ai's `/api/webhooks/graph` route does this — Graph
  hits it with `?validationToken=…` once when the subscription is
  created, and we echo the token back as `text/plain`.
- The OAuth scope `Mail.Read` (delegated) is sufficient. mail-ai
  already requests this during onboarding.

### Step-by-step

1. Choose a publicly reachable URL for the API server. In dev, use
   [`ngrok`](https://ngrok.com/) or
   [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
   to expose `127.0.0.1:8200` over HTTPS. In production, this is
   your normal API ingress.

2. Set the env var:

   ```sh
   export MAILAI_PUSH_GRAPH_WEBHOOK_URL=https://api.example.com/api/webhooks/graph
   ```

3. Restart the API server. Within ~30s the scheduler picks up
   healthy Outlook accounts, calls
   `POST https://graph.microsoft.com/v1.0/subscriptions`, and Graph
   replies with the validation handshake. The scheduler logs
   `[sync-scheduler] push subscription updated` on success.

### Lifetime

Subscriptions for `/messages` last ~3 days. The scheduler asks for
70 hours and renews with 6 hours of headroom. As with Gmail, a
short scheduler outage is tolerable; longer outages cause the
subscription to lapse, which the next tick repairs by creating a
fresh one.

### Multi-folder

The current adapter subscribes to `me/mailFolders('Inbox')/messages`
only. Outlook delta sync also runs on Inbox only, so this is
consistent — other folders fall back to periodic full sync. If you
need push for Sent/Trash, add a per-folder subscription path; the
adapter is small and the schema already supports multiple rows per
account by virtue of the `id` PK (the unique index is on
`(tenant_id, oauth_account_id)` today, which would need to drop one
of those columns to allow multiple rows).

### Removing push

Same shape as Gmail: unset the env var, restart, and either let
existing subscriptions lapse within 3 days or delete the rows + call
`DELETE /subscriptions/{id}` per account to unsubscribe immediately.

---

## Operational notes

### Observability

Inspect current subscriptions with:

```sh
curl -s http://127.0.0.1:8200/api/webhooks/_subscriptions/t_dev | jq .
```

The scheduler logs every subscribe / renew / failure. Pipe logs to
your aggregator and alert on
`[sync-scheduler] push: subscribe/renew failed` rates above
baseline.

### Failure modes

- **Webhook unreachable**: Pub/Sub retries for 7 days; Graph drops
  the subscription after 4 consecutive delivery failures. The
  scheduler will re-subscribe automatically once the URL is back.
- **OAuth revoked**: `getValidAccessToken` throws `auth_error`. The
  scheduler logs the failure and marks `last_error` on the
  subscription row. The next tick after re-authorization will
  recover.
- **Provider quota exhaustion**: Gmail caps at 1 watch / mailbox /
  hour and 1M total watches / project. Graph caps at ~5 active
  subscriptions per app per resource per user. The scheduler does
  not pre-emptively rate-limit; if you operate >5k mailboxes, plan
  for sharding by Cloud project / app registration.

### Security

- The webhook router never trusts an inbound URL or query parameter
  for routing. Gmail payloads are routed by the verified
  `emailAddress` field inside the Pub/Sub envelope; Graph payloads
  are routed by the `clientState` we generated and persisted.
- `clientState` is 128 bits of crypto-random hex per subscription.
  Graph treats it as opaque; we use it as the lookup key on the way
  in.
- Webhook routes always return `204` / `202` even on malformed input
  to avoid leaking information about subscription state to a port
  scanner. Errors land in the server logs.

### Disabling push without disabling sync

Set `MAILAI_SYNC_DISABLED=1` to disable everything (scheduler +
push). To disable push only, simply omit both
`MAILAI_PUSH_GMAIL_TOPIC` and `MAILAI_PUSH_GRAPH_WEBHOOK_URL`. The
periodic poll loop continues to run.
