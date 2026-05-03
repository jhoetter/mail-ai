// Unit coverage for the SyncScheduler. We exercise the scheduling
// logic (per-account interval + exponential backoff + concurrency
// cap) and the realtime fan-out (sync events landing on the
// EventBroadcaster) against an in-memory `SyncDriver` and a
// fake-timer clock.
//
// The scheduler is deliberately NOT instantiated with a real Pool —
// the production Postgres driver lives in `buildPostgresDriver` and
// is covered by oauth/sync.ts integration tests. These tests focus
// on the orchestration layer.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { EventBroadcaster, type MailaiEvent } from "../events.js";
import { SyncScheduler, type SyncDriver, type SyncSchedulerDeps } from "./scheduler.js";
import type { OauthAccountRow } from "@mailai/overlay-db";
import type { SyncResult } from "../oauth/sync.js";

function makeAccount(partial: Partial<OauthAccountRow> & { id: string }): OauthAccountRow {
  const now = new Date(0);
  return {
    id: partial.id,
    tenantId: partial.tenantId ?? "t_test",
    userId: partial.userId ?? "u_test",
    provider: partial.provider ?? "google-mail",
    email: partial.email ?? `${partial.id}@example.com`,
    accessToken: "tok",
    refreshToken: null,
    tokenType: "Bearer",
    scope: null,
    expiresAt: null,
    nangoConnectionId: null,
    nangoProviderConfigKey: null,
    rawJson: null,
    status: partial.status ?? "ok",
    createdAt: now,
    updatedAt: now,
    lastRefreshedAt: null,
    lastSyncedAt: partial.lastSyncedAt ?? null,
    lastSyncError: partial.lastSyncError ?? null,
    signatureHtml: null,
    signatureText: null,
    historyId: null,
    deltaLink: null,
    vacationEnabled: false,
    vacationSubject: null,
    vacationMessage: null,
    vacationStartsAt: null,
    vacationEndsAt: null,
  };
}

const okResult = (): SyncResult => ({
  fetched: 1,
  inserted: 1,
  updated: 0,
  deleted: 0,
  durationMs: 5,
  mode: "full",
  perFolder: [{ folder: "inbox", fetched: 1 }],
});

interface FakeDriverState {
  readonly accounts: Map<string, OauthAccountRow>;
  // accountId -> array of "what to do on the Nth call".
  // Each entry is either a result (success) or "fail" (rejected promise).
  readonly responses: Map<string, ("ok" | "fail")[]>;
  readonly callLog: { tenantId: string; accountId: string; at: number }[];
  // Simulate a slow remote so the concurrency test can observe the
  // overlap between in-flight syncs.
  readonly latencyMs: number;
}

function makeFakeDriver(state: FakeDriverState, clock: { now: () => number }): SyncDriver {
  return {
    async listAccounts(tenantId) {
      return [...state.accounts.values()].filter((a) => a.tenantId === tenantId);
    },
    async runSync(tenantId, accountId) {
      state.callLog.push({ tenantId, accountId, at: clock.now() });
      if (state.latencyMs > 0) {
        await new Promise((r) => setTimeout(r, state.latencyMs));
      }
      const queue = state.responses.get(accountId) ?? ["ok"];
      const next = queue.shift() ?? "ok";
      // Mutate `lastSyncedAt` to mirror what `markSync` would do
      // inside the real driver — this is what the next-tick due-ness
      // check reads.
      const acc = state.accounts.get(accountId);
      if (acc) {
        state.accounts.set(accountId, {
          ...acc,
          lastSyncedAt: new Date(clock.now()),
          lastSyncError: next === "fail" ? "boom" : null,
        });
      }
      if (next === "fail") throw new Error("boom");
      return okResult();
    },
  };
}

interface Harness {
  readonly scheduler: SyncScheduler;
  readonly broadcaster: EventBroadcaster;
  readonly events: MailaiEvent[];
  readonly state: FakeDriverState;
}

function makeHarness(opts: {
  accounts: OauthAccountRow[];
  baseIntervalMs?: number;
  maxConcurrent?: number;
  responses?: Map<string, ("ok" | "fail")[]>;
  latencyMs?: number;
}): Harness {
  const broadcaster = new EventBroadcaster();
  const events: MailaiEvent[] = [];
  // Snoop on broadcaster.publish so we don't need a real WebSocket
  // server for the unit suite.
  const realPublish = broadcaster.publish.bind(broadcaster);
  broadcaster.publish = (e) => {
    events.push(e);
    return realPublish(e);
  };
  const state: FakeDriverState = {
    accounts: new Map(opts.accounts.map((a) => [a.id, a])),
    responses: opts.responses ?? new Map(),
    callLog: [],
    latencyMs: opts.latencyMs ?? 0,
  };
  const driver = makeFakeDriver(state, { now: () => Date.now() });
  const deps: SyncSchedulerDeps = {
    broadcaster,
    tenants: async () => ["t_test"],
    driver,
    baseIntervalMs: opts.baseIntervalMs ?? 60_000,
    tickIntervalMs: 5_000,
    ...(opts.maxConcurrent !== undefined ? { maxConcurrent: opts.maxConcurrent } : {}),
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  };
  const scheduler = new SyncScheduler(deps);
  return { scheduler, broadcaster, events, state };
}

describe("SyncScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("syncs every never-synced account on the first tick", async () => {
    const h = makeHarness({
      accounts: [makeAccount({ id: "oa_a" }), makeAccount({ id: "oa_b" })],
    });
    await h.scheduler.tick();
    expect(h.state.callLog.map((c) => c.accountId).sort()).toEqual(["oa_a", "oa_b"]);
    expect(h.events).toHaveLength(2);
    expect(h.events.every((e) => e.kind === "sync")).toBe(true);
  });

  it("skips accounts whose last sync is within the base interval", async () => {
    const tenMinAgo = new Date(-1); // older than now(=0) so it's "stale"
    void tenMinAgo;
    const h = makeHarness({
      accounts: [
        // Synced "right now" → not due
        makeAccount({ id: "oa_fresh", lastSyncedAt: new Date(0) }),
        // Never synced → due
        makeAccount({ id: "oa_due" }),
      ],
      baseIntervalMs: 60_000,
    });
    await h.scheduler.tick();
    expect(h.state.callLog.map((c) => c.accountId)).toEqual(["oa_due"]);
  });

  it("re-syncs once the base interval has elapsed", async () => {
    const h = makeHarness({
      accounts: [makeAccount({ id: "oa_a" })],
      baseIntervalMs: 60_000,
    });
    await h.scheduler.tick();
    expect(h.state.callLog).toHaveLength(1);

    // Less than one interval later → still not due.
    vi.setSystemTime(30_000);
    await h.scheduler.tick();
    expect(h.state.callLog).toHaveLength(1);

    // Past the interval → due again.
    vi.setSystemTime(70_000);
    await h.scheduler.tick();
    expect(h.state.callLog).toHaveLength(2);
  });

  it("backs off exponentially after consecutive failures", async () => {
    const responses = new Map<string, ("ok" | "fail")[]>();
    // Fail on every call so the backoff grows without bound until the
    // cap kicks in.
    responses.set("oa_a", ["fail", "fail", "fail", "fail"]);
    const h = makeHarness({
      accounts: [makeAccount({ id: "oa_a" })],
      baseIntervalMs: 1_000,
      responses,
    });

    // Tick 1: never-synced, runs and fails. errorStreak becomes 1.
    await h.scheduler.tick();
    expect(h.state.callLog).toHaveLength(1);

    // 1.5s later — streak=1 means interval = base * BACKOFF[1] = 2s.
    // Not due yet.
    vi.setSystemTime(1_500);
    await h.scheduler.tick();
    expect(h.state.callLog).toHaveLength(1);

    // 3s later — past 2s window, fails again. streak=2, interval=4s.
    vi.setSystemTime(3_500);
    await h.scheduler.tick();
    expect(h.state.callLog).toHaveLength(2);

    // 5s later (only 1.5s after the failure) — still inside the 4s
    // window, so no call.
    vi.setSystemTime(5_000);
    await h.scheduler.tick();
    expect(h.state.callLog).toHaveLength(2);

    // 8s later (4.5s after last failure) — past the 4s window.
    vi.setSystemTime(8_000);
    await h.scheduler.tick();
    expect(h.state.callLog).toHaveLength(3);
  });

  it("resets the backoff after a successful run", async () => {
    const responses = new Map<string, ("ok" | "fail")[]>();
    responses.set("oa_a", ["fail", "ok"]);
    const h = makeHarness({
      accounts: [makeAccount({ id: "oa_a" })],
      baseIntervalMs: 1_000,
      responses,
    });

    await h.scheduler.tick();
    expect(h.state.callLog).toHaveLength(1);

    // After failure, streak=1 so next due is at +2s.
    vi.setSystemTime(2_500);
    await h.scheduler.tick();
    expect(h.state.callLog).toHaveLength(2);
    // That run succeeded, so streak resets and the next due time is
    // base interval (1s) again.
    vi.setSystemTime(3_700);
    await h.scheduler.tick();
    expect(h.state.callLog).toHaveLength(3);
  });

  it("skips accounts whose status is not 'ok'", async () => {
    const h = makeHarness({
      accounts: [
        makeAccount({ id: "oa_ok" }),
        makeAccount({ id: "oa_revoked", status: "revoked" }),
        makeAccount({ id: "oa_reauth", status: "needs-reauth" }),
      ],
    });
    await h.scheduler.tick();
    expect(h.state.callLog.map((c) => c.accountId)).toEqual(["oa_ok"]);
  });

  it("respects the maxConcurrent cap", async () => {
    // Use fake timers but fall back to real for the latency promise.
    vi.useRealTimers();
    const h = makeHarness({
      accounts: [
        makeAccount({ id: "oa_a" }),
        makeAccount({ id: "oa_b" }),
        makeAccount({ id: "oa_c" }),
        makeAccount({ id: "oa_d" }),
        makeAccount({ id: "oa_e" }),
      ],
      maxConcurrent: 2,
      latencyMs: 30,
    });
    await h.scheduler.tick();
    expect(h.state.callLog).toHaveLength(5);
    // First two calls are scheduled together (both at ~tick start).
    // Worker 0 finishes its first call (~30ms in), then picks up the
    // 3rd. So the 3rd call's `at` should be >= 30ms past the first.
    const first = h.state.callLog[0]!.at;
    const third = h.state.callLog[2]!.at;
    expect(third - first).toBeGreaterThanOrEqual(20);
  });

  it("publishes a sync event with the right shape after success", async () => {
    const h = makeHarness({
      accounts: [makeAccount({ id: "oa_a", tenantId: "t_test" })],
    });
    await h.scheduler.tick();
    expect(h.events).toHaveLength(1);
    const evt = h.events[0];
    expect(evt).toBeDefined();
    if (!evt || evt.kind !== "sync") {
      throw new Error("expected a sync event");
    }
    expect(evt.tenantId).toBe("t_test");
    expect(evt.accountId).toBe("oa_a");
    expect(evt.counts).toEqual({
      fetched: 1,
      inserted: 1,
      updated: 0,
      deleted: 0,
    });
    expect(typeof evt.at).toBe("string");
  });

  it("does NOT publish a sync event on failure", async () => {
    const responses = new Map<string, ("ok" | "fail")[]>();
    responses.set("oa_a", ["fail"]);
    const h = makeHarness({
      accounts: [makeAccount({ id: "oa_a" })],
      responses,
    });
    await h.scheduler.tick();
    expect(h.events).toHaveLength(0);
  });

  it("re-entry is gated: a second tick during an in-flight one is a no-op", async () => {
    vi.useRealTimers();
    const h = makeHarness({
      accounts: [makeAccount({ id: "oa_a" })],
      latencyMs: 50,
    });
    const first = h.scheduler.tick();
    const second = h.scheduler.tick();
    await Promise.all([first, second]);
    expect(h.state.callLog).toHaveLength(1);
  });

  it("stop() drains in-flight syncs", async () => {
    vi.useRealTimers();
    const h = makeHarness({
      accounts: [makeAccount({ id: "oa_a" })],
      latencyMs: 50,
    });
    h.scheduler.start();
    // Wait long enough for the kick-on-start tick to actually start
    // the underlying sync.
    await new Promise((r) => setTimeout(r, 5));
    await h.scheduler.stop();
    expect(h.state.callLog).toHaveLength(1);
    expect(h.scheduler.stats().inFlight).toBe(0);
    expect(h.scheduler.stats().running).toBe(false);
  });

  it("fan-out reaches a real WebSocket subscriber", async () => {
    vi.useRealTimers();
    const h = makeHarness({
      accounts: [makeAccount({ id: "oa_a" })],
    });
    // Stand up an actual ws server bound to the broadcaster, then
    // connect a client and assert that publishing an event reaches it.
    const wss = new WebSocketServer({ port: 0 });
    h.broadcaster.attach(wss);
    const port = (wss.address() as { port: number }).port;
    const { WebSocket } = await import("ws");
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => client.on("open", () => resolve()));
    const received: MailaiEvent[] = [];
    client.on("message", (raw) => {
      received.push(JSON.parse(raw.toString()) as MailaiEvent);
    });
    await h.scheduler.tick();
    // Allow the message to traverse the loopback socket.
    await new Promise((r) => setTimeout(r, 50));
    client.close();
    await new Promise((r) => setTimeout(r, 10));
    wss.close();
    expect(received).toHaveLength(1);
    expect(received[0]?.kind).toBe("sync");
  });
});
