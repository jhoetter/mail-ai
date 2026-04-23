// OutlookMailPushAdapter — implements the PushProvider port against
// Microsoft Graph's /subscriptions surface.
//
// Graph subscriptions are per-resource and per-tenant: we ask for
// `me/mailFolders('Inbox')/messages` and Graph POSTs change
// notifications to `notificationUrl` whenever a message is created
// / updated / deleted in the Inbox. The webhook router echoes back
// the validation token on the initial handshake (Graph requires it
// to confirm the URL is owned by us), then matches incoming
// `clientState` to a row in `oauth_push_subscriptions` and queues
// an immediate pullDelta.
//
// Lifetime ceiling for /messages is ~3 days; we ask for 70 hours
// so we always have an opportunity to renew before Graph drops the
// subscription.

import type {
  AccessTokenArgs,
  PushProvider,
  PushProviderCapabilities,
  PushSubscription,
  SubscribeArgs,
} from "@mailai/providers";
import {
  createGraphMailSubscription,
  deleteGraphMailSubscription,
  renewGraphMailSubscription,
} from "../graph.js";

const MAX_LIFETIME_MS = 70 * 60 * 60 * 1000; // 70h, well under Graph's ~71.5h ceiling
const RENEWAL_LEAD_MS = 6 * 60 * 60 * 1000; // renew with 6h headroom

const CAPABILITIES: PushProviderCapabilities = {
  supported: true,
  maxLifetimeMs: MAX_LIFETIME_MS,
  renewalLeadMs: RENEWAL_LEAD_MS,
};

function defaultExpirationIso(): string {
  return new Date(Date.now() + MAX_LIFETIME_MS).toISOString();
}

export class OutlookMailPushAdapter implements PushProvider {
  readonly id = "outlook" as const;
  readonly capabilities: PushProviderCapabilities = CAPABILITIES;

  async subscribe(args: AccessTokenArgs & SubscribeArgs): Promise<PushSubscription> {
    const sub = await createGraphMailSubscription({
      accessToken: args.accessToken,
      notificationUrl: args.notificationUrl,
      clientState: args.clientState,
      expirationDateTime: defaultExpirationIso(),
    });
    return {
      providerSubscriptionId: sub.id,
      expiresAt: sub.expirationDateTime,
      // Graph echoes clientState back on every notification; the
      // webhook router uses it as the lookup key. We persist it in
      // opaqueState so renewal calls can re-supply the same value
      // (though Graph also stores it server-side).
      opaqueState: args.clientState,
    };
  }

  async renew(
    args: AccessTokenArgs & {
      subscription: PushSubscription;
      notificationUrl: string;
      clientState: string;
    },
  ): Promise<PushSubscription> {
    try {
      const sub = await renewGraphMailSubscription({
        accessToken: args.accessToken,
        subscriptionId: args.subscription.providerSubscriptionId,
        expirationDateTime: defaultExpirationIso(),
      });
      return {
        providerSubscriptionId: sub.id,
        expiresAt: sub.expirationDateTime,
        opaqueState: args.clientState,
      };
    } catch (err) {
      // If Graph already dropped the subscription (404/410 surfaced
      // as a generic 404 in the helper's error message) the only
      // recovery is to subscribe fresh. Re-thrown errors are left
      // for the scheduler to handle with backoff.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("404") || msg.includes("410")) {
        return this.subscribe({
          accessToken: args.accessToken,
          notificationUrl: args.notificationUrl,
          clientState: args.clientState,
        });
      }
      throw err;
    }
  }

  async unsubscribe(args: AccessTokenArgs & { subscription: PushSubscription }): Promise<void> {
    await deleteGraphMailSubscription({
      accessToken: args.accessToken,
      subscriptionId: args.subscription.providerSubscriptionId,
    });
  }
}
