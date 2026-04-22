// PushProvider — port for "tell me when this mailbox changes" so
// the SyncScheduler can stop polling cold mailboxes and react in
// near-realtime to new mail.
//
// Both Gmail (users.watch + Cloud Pub/Sub) and Microsoft Graph
// (/me/subscriptions + webhook validation handshake) issue tokens
// with a finite lifetime: Gmail caps at 7 days, Graph at ~3 days
// for messages. The scheduler is responsible for renewing before
// the token expires; this port stays narrow on subscribe / renew /
// unsubscribe so adapters don't have to model push semantics
// twice.
//
// Webhook payloads are decoded by the server's webhook routes (see
// packages/server/src/routes/webhooks.ts) and turned into a
// `kind: "delta"` request that the scheduler picks up immediately
// instead of waiting for the next poll tick. That coupling lives
// outside this port — adapters never see the webhook itself.

import type { MailProviderId } from "../types.js";
import type { AccessTokenArgs } from "../mail/port.js";

export type { AccessTokenArgs };

// Subscription metadata persisted in `oauth_push_subscriptions`.
// The opaque `providerSubscriptionId` is what the adapter passes
// back to renew() / unsubscribe(); the server uses the rest to
// route incoming webhook payloads back to the right account.
export interface PushSubscription {
  readonly providerSubscriptionId: string;
  // ISO timestamp of the provider's TTL. The scheduler renews
  // when we're within `renewalLeadMs` of this.
  readonly expiresAt: string;
  // Opaque adapter state that survives the renewal call. Gmail
  // doesn't need it; Graph stores the clientState here so the
  // webhook validator can compare against the inbound payload.
  readonly opaqueState: string | null;
}

export interface PushProviderCapabilities {
  // Whether this transport supports a per-mailbox subscription at
  // all. False adapters are skipped silently by the scheduler.
  readonly supported: boolean;
  // Hard upper bound on subscription lifetime, in ms. The scheduler
  // uses this together with `renewalLeadMs` below to decide when
  // to renew. Gmail = 7 days, Graph mail = 3 days.
  readonly maxLifetimeMs: number;
  // How early before `expiresAt` to renew. Defaults to 1h; the
  // scheduler tightens this for adapters with very short lifetimes.
  readonly renewalLeadMs: number;
}

export interface SubscribeArgs {
  // Where the provider should POST notifications. The webhook
  // routes own this URL; we pass it in so the same code path works
  // for staging / production / per-tenant ingress.
  readonly notificationUrl: string;
  // Server-side identifier the webhook handler uses to look the
  // account back up. Echoed back by the provider on every push.
  readonly clientState: string;
}

export interface PushProvider {
  readonly id: MailProviderId;
  readonly capabilities: PushProviderCapabilities;

  // Create a fresh subscription pointing at the given webhook URL.
  // Adapters are responsible for any provider-specific handshake
  // (Graph's POST → 200 validationToken handshake is server-side;
  // the adapter just initiates the subscription).
  subscribe(
    args: AccessTokenArgs & SubscribeArgs,
  ): Promise<PushSubscription>;

  // Refresh an existing subscription so it doesn't expire. Returns
  // the new expiresAt + (potentially new) providerSubscriptionId.
  // Adapters whose providers can't renew in place are free to
  // unsubscribe + re-subscribe under the hood; the caller only
  // sees a new subscription record.
  renew(
    args: AccessTokenArgs & {
      subscription: PushSubscription;
      // Same notification target as the original subscribe call;
      // re-supplied because Graph requires it on every PATCH.
      notificationUrl: string;
      clientState: string;
    },
  ): Promise<PushSubscription>;

  // Tear down a subscription. Idempotent — adapters MUST treat
  // 404/410 as success since the only thing the caller can do on
  // failure is retry-then-give-up anyway.
  unsubscribe(
    args: AccessTokenArgs & { subscription: PushSubscription },
  ): Promise<void>;
}
