// GoogleMailPushAdapter — implements the PushProvider port against
// Gmail's `users.watch` + Cloud Pub/Sub flow.
//
// Gmail doesn't push HTTP webhooks directly. Instead, we register a
// Pub/Sub topic via users.watch; Pub/Sub then POSTs messages to the
// topic's push subscription, which is the URL we expose under
// /api/webhooks/gmail. Each push payload contains the mailbox
// emailAddress + historyId, which the webhook router uses to look
// the account back up and trigger an immediate pullDelta tick.
//
// `notificationUrl` here is overloaded: it carries the
// fully-qualified Pub/Sub topic name
// (`projects/<project>/topics/<topic>`) configured at deploy time.
// The push port treats it as opaque routing metadata; the actual
// HTTP endpoint lives in the Pub/Sub subscription, not in this
// argument. We accept the overload because the alternative — adding
// a separate `topicName` argument to the port — would leak Gmail's
// transport details everywhere else.

import type {
  AccessTokenArgs,
  PushProvider,
  PushProviderCapabilities,
  PushSubscription,
  SubscribeArgs,
} from "@mailai/providers";
import { stopGmailMailboxWatch, watchGmailMailbox } from "../gmail.js";

// Gmail caps users.watch at 7 days; we renew with ~24h of headroom
// so a short scheduler outage doesn't drop the subscription.
const MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const RENEWAL_LEAD_MS = 24 * 60 * 60 * 1000;

const CAPABILITIES: PushProviderCapabilities = {
  supported: true,
  maxLifetimeMs: MAX_LIFETIME_MS,
  renewalLeadMs: RENEWAL_LEAD_MS,
};

export class GoogleMailPushAdapter implements PushProvider {
  readonly id = "google-mail" as const;
  readonly capabilities: PushProviderCapabilities = CAPABILITIES;

  async subscribe(
    args: AccessTokenArgs & SubscribeArgs,
  ): Promise<PushSubscription> {
    const watch = await watchGmailMailbox({
      accessToken: args.accessToken,
      // notificationUrl == Pub/Sub topic name; see file comment.
      topicName: args.notificationUrl,
      labelIds: ["INBOX"],
    });
    return {
      // Gmail doesn't return a per-watch id — the watch is keyed by
      // (project, mailbox). We synthesize a stable id from the
      // historyId at watch time so the row in oauth_push_subscriptions
      // has something to look up by; the webhook router routes
      // primarily on emailAddress out of the Pub/Sub payload.
      providerSubscriptionId: `gmail-watch:${watch.historyId}`,
      expiresAt: new Date(watch.expiration).toISOString(),
      // Topic name is the only piece of state we need to remember
      // across renewals — the subscribe() caller in the scheduler
      // passes it back to us via SubscribeArgs.notificationUrl.
      opaqueState: args.notificationUrl,
    };
  }

  async renew(
    args: AccessTokenArgs & {
      subscription: PushSubscription;
      notificationUrl: string;
      clientState: string;
    },
  ): Promise<PushSubscription> {
    // Gmail has no in-place renew; calling watch() again with the
    // same topic resets the 7-day TTL. We don't stop() first —
    // Google explicitly documents that re-watching is the renewal
    // mechanism.
    return this.subscribe({
      accessToken: args.accessToken,
      notificationUrl: args.notificationUrl,
      clientState: args.clientState,
    });
  }

  async unsubscribe(
    args: AccessTokenArgs & { subscription: PushSubscription },
  ): Promise<void> {
    void args.subscription;
    await stopGmailMailboxWatch({ accessToken: args.accessToken });
  }
}
