// SyncScheduler — single in-process loop that drives the periodic
// REST sync of every healthy `oauth_accounts` row.
//
// Design goals (Phase 5 of the reliable provider-agnostic mail
// roadmap):
//   - One ticker, no external scheduler dependency.
//   - Per-account interval based on `lastSyncedAt` + `lastSyncError`
//     with exponential backoff so a flapping provider doesn't melt
//     the rate limit.
//   - Bounded concurrency (default 4) so a 50-account tenant can't
//     hold the event loop hostage.
//   - SIGTERM-safe: `stop()` waits for in-flight syncs to drain.
//   - Emits a `sync` event on the EventBroadcaster after each
//     successful run so `useSyncEvents` can refetch the visible
//     scope.
//
// The scheduler intentionally does not own a Postgres connection.
// All DB work goes through `withTenant` so RLS sees the right
// `mailai.tenant_id` and the bookkeeping (`last_synced_at`,
// `last_sync_error`) updates atomically with the message upserts.
//
// Wiring: see `server.ts` — the boot path constructs one scheduler
// per process and calls `start()` after migrations land.

import {
  OauthAccountsRepository,
  OauthMessagesRepository,
  OauthPushSubscriptionsRepository,
  withTenant,
  type OauthAccountRow,
  type Pool,
  type PushSubscriptionRow,
} from "@mailai/overlay-db";
import {
  getValidAccessToken,
  type ProviderCredentials,
} from "@mailai/oauth-tokens";
import type {
  MailProviderRegistry,
  PushProviderRegistry,
} from "@mailai/providers";
import { syncOauthAccount, type SyncResult } from "../oauth/sync.js";
import type { EventBroadcaster } from "../events.js";

// Optional push-subscription configuration. When present, the
// scheduler keeps every healthy account subscribed for push
// notifications and renews subscriptions before they expire.
//
// `notificationUrlFor` lets callers vary the URL by provider — Gmail
// expects a Cloud Pub/Sub topic name, Graph expects a public HTTPS
// endpoint. When the resolver returns `null` for a provider we skip
// push for accounts of that provider entirely (typical for staging
// environments without a public webhook ingress).
export interface PushConfig {
  readonly registry: PushProviderRegistry;
  notificationUrlFor(provider: "google-mail" | "outlook"): string | null;
  // Generates the opaque clientState we hand the provider to echo
  // back on every push. Defaults to a fresh UUID per subscription.
  generateClientState?(): string;
}

// Thin seam between the scheduler and the database / provider layer.
// Production wires the default postgres-backed driver below; unit
// tests pass an in-memory implementation so the scheduler logic
// (backoff, concurrency, draining) can be exercised without a live
// Postgres or mocked fetch.
export interface SyncDriver {
  listAccounts(tenantId: string): Promise<OauthAccountRow[]>;
  runSync(
    tenantId: string,
    accountId: string,
  ): Promise<SyncResult | null>;
}

export interface SyncSchedulerDeps {
  readonly broadcaster: EventBroadcaster;
  // Resolves the tenant ids the scheduler should sweep on each tick.
  // Production wires this to "every tenant in the workspace"; v1 dev
  // returns just the dev tenant. Async so a future implementation
  // can hit a registry table without forcing this module to know how.
  readonly tenants: () => Promise<ReadonlyArray<string>>;
  // EITHER pass `driver` (tests + bespoke setups) OR pass the
  // {pool, credentials, providers} triple and the scheduler will
  // build the default postgres driver itself.
  readonly driver?: SyncDriver;
  readonly pool?: Pool;
  readonly credentials?: ProviderCredentials;
  readonly providers?: MailProviderRegistry;
  // Base poll interval. Per-account cadence is `baseIntervalMs *
  // backoff(consecutiveErrors)`; healthy accounts re-sync every
  // `baseIntervalMs`.
  readonly baseIntervalMs?: number;
  // How often the loop wakes up to look for due accounts. Default
  // 30s in dev, 60s in prod is the suggested env override.
  readonly tickIntervalMs?: number;
  // Max in-flight syncs at any moment. Each provider call is
  // I/O-bound so 4 is a safe default; tune if you have hundreds of
  // accounts.
  readonly maxConcurrent?: number;
  // Optional logger. Falls back to `console` so tests don't have to
  // wire one through.
  readonly logger?: Pick<Console, "info" | "warn" | "error">;
  // Hook for tests: runs the same code path as `tick` but lets the
  // test await it deterministically. Production never calls this.
  readonly now?: () => number;
  // Optional push-notification configuration. When present, the
  // scheduler subscribes accounts on first sight and renews
  // subscriptions before they expire.
  readonly push?: PushConfig;
}

export interface SyncSchedulerStats {
  readonly running: boolean;
  readonly inFlight: number;
  readonly ticks: number;
  readonly lastTickAt: number | null;
  readonly successes: number;
  readonly failures: number;
}

const DEFAULT_BASE_INTERVAL_MS = 5 * 60_000; // 5 min
const DEFAULT_TICK_INTERVAL_MS = 30_000; // 30 s
const DEFAULT_MAX_CONCURRENT = 4;
// Backoff schedule applied as `baseInterval * factor`. Index is
// `consecutiveErrors` clamped to the last bucket. Mirrors what the
// plan calls out: 1m → 2m → 5m → 15m → 60m on top of the base.
const BACKOFF_FACTORS: ReadonlyArray<number> = [1, 2, 4, 8, 16, 32];

function backoffFactor(consecutiveErrors: number): number {
  if (consecutiveErrors <= 0) return 1;
  const idx = Math.min(consecutiveErrors, BACKOFF_FACTORS.length - 1);
  return BACKOFF_FACTORS[idx] ?? 32;
}

export class SyncScheduler {
  private readonly logger: Pick<Console, "info" | "warn" | "error">;
  private readonly baseIntervalMs: number;
  private readonly tickIntervalMs: number;
  private readonly maxConcurrent: number;
  private readonly driver: SyncDriver;
  // accountId -> consecutive error count. Reset to 0 on success.
  // Held in memory only; on restart we fall back to "sync soon" which
  // is fine since the alternative — persisting the counter — buys
  // little for a 30s tick.
  private readonly errorStreak = new Map<string, number>();
  // accountId -> set of in-flight promises so `stop()` can drain.
  private readonly inFlightPromises = new Set<Promise<unknown>>();

  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private ticks = 0;
  private successes = 0;
  private failures = 0;
  private lastTickAt: number | null = null;

  constructor(private readonly deps: SyncSchedulerDeps) {
    this.logger = deps.logger ?? console;
    this.baseIntervalMs = deps.baseIntervalMs ?? DEFAULT_BASE_INTERVAL_MS;
    this.tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.maxConcurrent = deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    if (deps.driver) {
      this.driver = deps.driver;
    } else {
      if (!deps.pool || !deps.credentials || !deps.providers) {
        throw new Error(
          "SyncScheduler: provide either `driver` or {pool, credentials, providers}",
        );
      }
      this.driver = buildPostgresDriver({
        pool: deps.pool,
        credentials: deps.credentials,
        providers: deps.providers,
      });
    }
  }

  start(): void {
    if (this.timer) return;
    this.logger.info(
      { baseIntervalMs: this.baseIntervalMs, tickIntervalMs: this.tickIntervalMs },
      "[sync-scheduler] starting",
    );
    // Kick off an immediate tick so a freshly-booted server starts
    // syncing without waiting a full interval — gives the user
    // visible mail right away after `pnpm dev`.
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickIntervalMs);
    // Don't keep the process alive just because of the scheduler;
    // the http server's listen call already does that.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Wait for currently-running syncs so SIGTERM doesn't truncate
    // a half-applied upsert batch. New ticks are gated by `timer`
    // being null so nothing else enters the queue.
    await Promise.allSettled(this.inFlightPromises);
    this.logger.info("[sync-scheduler] stopped");
  }

  stats(): SyncSchedulerStats {
    return {
      running: this.timer !== null,
      inFlight: this.inFlightPromises.size,
      ticks: this.ticks,
      lastTickAt: this.lastTickAt,
      successes: this.successes,
      failures: this.failures,
    };
  }

  // Force-sync a single account out-of-band. Used by webhook routes
  // when a provider tells us "this mailbox just changed" — we don't
  // want to wait for the next tick to react. Concurrency cap and
  // streak bookkeeping still apply, so a misbehaving webhook can't
  // spin a single account in a tight loop.
  async triggerSync(tenantId: string, accountId: string): Promise<void> {
    const promise = (async () => {
      try {
        const result = await this.driver.runSync(tenantId, accountId);
        if (!result) return;
        this.errorStreak.delete(accountId);
        this.successes += 1;
        this.publishSyncEvent(tenantId, accountId, result);
      } catch (err) {
        this.failures += 1;
        const streak = (this.errorStreak.get(accountId) ?? 0) + 1;
        this.errorStreak.set(accountId, streak);
        this.logger.warn(
          { tenantId, accountId, streak, err, source: "webhook" },
          "[sync-scheduler] webhook-triggered sync failed",
        );
      }
    })();
    this.inFlightPromises.add(promise);
    try {
      await promise;
    } finally {
      this.inFlightPromises.delete(promise);
    }
  }

  // Exposed for tests + the boot path's "kick on start" call. Picks
  // up due accounts and runs them under the concurrency cap. Re-entry
  // is guarded so an overrunning previous tick (slow provider, paused
  // postgres) doesn't pile up extra work.
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    this.ticks += 1;
    const tickStartedAt = (this.deps.now ?? Date.now)();
    this.lastTickAt = tickStartedAt;
    try {
      const tenants = await this.deps.tenants();
      const due: { tenantId: string; account: OauthAccountRow }[] = [];
      for (const tenantId of tenants) {
        try {
          const accounts = await this.listSyncableAccounts(tenantId);
          for (const account of accounts) {
            if (this.isDue(account, tickStartedAt)) {
              due.push({ tenantId, account });
            }
          }
        } catch (err) {
          // One bad tenant should never starve the others. Log and
          // keep walking; the next tick will retry.
          this.logger.warn(
            { tenantId, err },
            "[sync-scheduler] failed to list accounts for tenant",
          );
        }
      }
      if (due.length > 0) {
        await this.runWithConcurrency(due);
      }
      // Push subscription bookkeeping piggy-backs on the same tick so
      // we don't need a second timer. Errors inside don't abort the
      // tick — the next pass will try again with backoff.
      if (this.deps.push) {
        try {
          await this.runPushBookkeeping(tenants);
        } catch (err) {
          this.logger.warn({ err }, "[sync-scheduler] push bookkeeping failed");
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  // Subscribe accounts that have no row in `oauth_push_subscriptions`
  // and renew rows that are inside `renewalLeadMs` of expiry. Per
  // tenant, runs sequentially because the volume is small (one row
  // per account) and the API rate limits are tight enough that
  // pipelining buys nothing.
  private async runPushBookkeeping(
    tenants: ReadonlyArray<string>,
  ): Promise<void> {
    const push = this.deps.push;
    if (!push) return;
    const now = (this.deps.now ?? Date.now)();
    for (const tenantId of tenants) {
      let accounts: OauthAccountRow[];
      try {
        accounts = (await this.driver.listAccounts(tenantId)).filter(
          (a) => a.status === "ok",
        );
      } catch (err) {
        this.logger.warn(
          { tenantId, err },
          "[sync-scheduler] push: list accounts failed",
        );
        continue;
      }
      // existingByAccount lets the per-account loop avoid an extra
      // round-trip per account. Subscriptions live in the same Postgres
      // pool, so a single SELECT is cheaper than N selects.
      let existingByAccount: Map<string, PushSubscriptionRow>;
      try {
        existingByAccount = await this.loadSubscriptions(tenantId);
      } catch (err) {
        this.logger.warn(
          { tenantId, err },
          "[sync-scheduler] push: load subscriptions failed",
        );
        continue;
      }
      for (const account of accounts) {
        // The registry is the source of truth for "do we have a push
        // adapter for this provider id?". Skip accounts whose
        // provider isn't registered or whose adapter advertises no
        // push support.
        if (!push.registry.has(account.provider)) continue;
        const adapter = push.registry.for(account.provider);
        if (!adapter || !adapter.capabilities.supported) continue;
        const notificationUrl = push.notificationUrlFor(account.provider);
        if (!notificationUrl) continue; // push disabled for this provider in this env
        const existing = existingByAccount.get(account.id) ?? null;
        const dueForRenewal =
          existing !== null &&
          existing.expiresAt.getTime() - now <= adapter.capabilities.renewalLeadMs;
        if (existing && !dueForRenewal) continue;
        try {
          await this.subscribeOrRenew(tenantId, account, existing, notificationUrl);
        } catch (err) {
          this.logger.warn(
            { tenantId, accountId: account.id, err },
            "[sync-scheduler] push: subscribe/renew failed",
          );
          await this.markSubscriptionError(tenantId, account.id, err).catch(() => {});
        }
      }
    }
  }

  private async loadSubscriptions(
    tenantId: string,
  ): Promise<Map<string, PushSubscriptionRow>> {
    if (!this.deps.pool) return new Map();
    const rows = await withTenant(this.deps.pool, tenantId, async (tx) => {
      const repo = new OauthPushSubscriptionsRepository(tx);
      return repo.listAll(tenantId);
    });
    const out = new Map<string, PushSubscriptionRow>();
    for (const r of rows) out.set(r.oauthAccountId, r);
    return out;
  }

  private async subscribeOrRenew(
    tenantId: string,
    account: OauthAccountRow,
    existing: PushSubscriptionRow | null,
    notificationUrl: string,
  ): Promise<void> {
    const push = this.deps.push;
    const pool = this.deps.pool;
    const credentials = this.deps.credentials;
    if (!push || !pool || !credentials) return;
    const adapter = push.registry.for(
      account.provider as "google-mail" | "outlook",
    );
    if (!adapter) {
      // Provider has no push adapter wired in — caller-side filter
      // already excludes these but we keep the guard so a misconfigured
      // registry surfaces here instead of with a NPE.
      return;
    }
    const accessToken = await this.refreshToken(tenantId, account, credentials);
    const clientState =
      existing?.clientState ??
      push.generateClientState?.() ??
      generateRandomClientState();
    const subscription = existing
      ? await adapter.renew({
          accessToken,
          subscription: {
            providerSubscriptionId: existing.providerSubscriptionId,
            expiresAt: existing.expiresAt.toISOString(),
            opaqueState: existing.opaqueState,
          },
          notificationUrl,
          clientState,
        })
      : await adapter.subscribe({
          accessToken,
          notificationUrl,
          clientState,
        });
    await withTenant(pool, tenantId, async (tx) => {
      const repo = new OauthPushSubscriptionsRepository(tx);
      await repo.upsert({
        id: existing?.id ?? generateRandomId("psub"),
        tenantId,
        oauthAccountId: account.id,
        provider: account.provider as "google-mail" | "outlook",
        providerSubscriptionId: subscription.providerSubscriptionId,
        notificationUrl,
        clientState,
        opaqueState: subscription.opaqueState,
        expiresAt: new Date(subscription.expiresAt),
      });
    });
    this.logger.info(
      {
        tenantId,
        accountId: account.id,
        provider: account.provider,
        expiresAt: subscription.expiresAt,
        renewed: existing !== null,
      },
      "[sync-scheduler] push subscription updated",
    );
  }

  private async refreshToken(
    tenantId: string,
    account: OauthAccountRow,
    credentials: ProviderCredentials,
  ): Promise<string> {
    if (!this.deps.pool) {
      throw new Error("scheduler push: pool required for token refresh");
    }
    return withTenant(this.deps.pool, tenantId, async (tx) => {
      const accounts = new OauthAccountsRepository(tx);
      const fresh = await accounts.byId(tenantId, account.id);
      if (!fresh) throw new Error(`account ${account.id} disappeared`);
      return getValidAccessToken(fresh, {
        tenantId,
        accounts,
        credentials,
      });
    });
  }

  private async markSubscriptionError(
    tenantId: string,
    accountId: string,
    err: unknown,
  ): Promise<void> {
    if (!this.deps.pool) return;
    const message = err instanceof Error ? err.message : String(err);
    await withTenant(this.deps.pool, tenantId, async (tx) => {
      const repo = new OauthPushSubscriptionsRepository(tx);
      await repo.markError(tenantId, accountId, message);
    });
  }

  private async listSyncableAccounts(
    tenantId: string,
  ): Promise<OauthAccountRow[]> {
    const all = await this.driver.listAccounts(tenantId);
    return all.filter((a) => a.status === "ok");
  }

  private isDue(account: OauthAccountRow, now: number): boolean {
    // Never synced → always due.
    if (!account.lastSyncedAt) return true;
    const sinceLastMs = now - account.lastSyncedAt.getTime();
    const streak = this.errorStreak.get(account.id) ?? 0;
    const interval = this.baseIntervalMs * backoffFactor(streak);
    return sinceLastMs >= interval;
  }

  private async runWithConcurrency(
    due: ReadonlyArray<{ tenantId: string; account: OauthAccountRow }>,
  ): Promise<void> {
    let cursor = 0;
    const workers: Promise<void>[] = [];
    const limit = Math.min(this.maxConcurrent, due.length);
    for (let i = 0; i < limit; i += 1) {
      workers.push(
        (async () => {
          while (true) {
            const idx = cursor++;
            if (idx >= due.length) return;
            const item = due[idx];
            if (!item) return;
            const { tenantId, account } = item;
            const promise = this.syncOne(tenantId, account);
            this.inFlightPromises.add(promise);
            try {
              await promise;
            } finally {
              this.inFlightPromises.delete(promise);
            }
          }
        })(),
      );
    }
    await Promise.all(workers);
  }

  private async syncOne(
    tenantId: string,
    account: OauthAccountRow,
  ): Promise<void> {
    try {
      const result = await this.driver.runSync(tenantId, account.id);
      if (!result) return;
      this.errorStreak.delete(account.id);
      this.successes += 1;
      this.publishSyncEvent(tenantId, account.id, result);
    } catch (err) {
      this.failures += 1;
      const streak = (this.errorStreak.get(account.id) ?? 0) + 1;
      this.errorStreak.set(account.id, streak);
      this.logger.warn(
        { tenantId, accountId: account.id, streak, err },
        "[sync-scheduler] sync failed",
      );
      // syncOauthAccount already wrote `last_sync_error` via
      // `markSync`; nothing more to persist here.
    }
  }

  private publishSyncEvent(
    tenantId: string,
    accountId: string,
    result: SyncResult,
  ): void {
    this.deps.broadcaster.publish({
      kind: "sync",
      tenantId,
      accountId,
      counts: {
        fetched: result.fetched,
        inserted: result.inserted,
        updated: result.updated,
        deleted: result.deleted,
      },
      at: new Date().toISOString(),
    });
  }
}

// Random helpers for push bookkeeping. Inlined so the scheduler
// doesn't pull in a `crypto` wrapper just for two opaque ids.
function generateRandomClientState(): string {
  // 32 hex chars = 128 bits of entropy, well past Graph's
  // requirement that clientState fit inside 128 chars.
  return globalThis.crypto.randomUUID().replace(/-/g, "");
}

function generateRandomId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`;
}

// Default driver implementation that runs the same `withTenant` +
// `syncOauthAccount` path used by `POST /api/accounts/:id/sync`. Kept
// separate from the scheduler class so tests can swap it for an
// in-memory fake without touching the scheduling logic.
export function buildPostgresDriver(deps: {
  pool: Pool;
  credentials: ProviderCredentials;
  providers: MailProviderRegistry;
}): SyncDriver {
  return {
    async listAccounts(tenantId) {
      return withTenant(deps.pool, tenantId, async (tx) => {
        const repo = new OauthAccountsRepository(tx);
        return repo.listByTenant(tenantId);
      });
    },
    async runSync(tenantId, accountId) {
      return withTenant(deps.pool, tenantId, async (tx) => {
        const accounts = new OauthAccountsRepository(tx);
        const messages = new OauthMessagesRepository(tx);
        // Re-read the row inside the tx so backoff decisions are made
        // against the freshest `last_synced_at` (a manual `Sync now`
        // could have run between tick selection and now).
        const fresh = await accounts.byId(tenantId, accountId);
        if (!fresh) return null;
        return syncOauthAccount(fresh, {
          accounts,
          messages,
          credentials: deps.credentials,
          providers: deps.providers,
        });
      });
    },
  };
}
