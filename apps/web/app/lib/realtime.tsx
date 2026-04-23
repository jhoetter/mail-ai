// Single ws connection from the browser to the mail-ai realtime
// server (`apps/realtime-server` in prod, embedded in
// `packages/server/src/server.ts` in dev).
//
// We expose two surfaces:
//   - `RealtimeProvider` — wraps the React tree, owns the underlying
//     WebSocket and reconnect-with-backoff loop.
//   - `useSyncEvents(handler)` — subscribes to the `kind: "sync"`
//     subset; the Inbox + Settings pages call this to refetch the
//     visible scope when a background sync writes new rows.
//
// A separate `useMutationEvents` hook will land alongside Phase 7
// when the broadcaster starts publishing presence/mutation events
// to the same channel. Keeping the surface small keeps the
// integration tests honest.

import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { runtimeWsBase } from "./runtime-config";

// Mirrors `MailaiEvent` from packages/server/src/events.ts. Kept as
// a local type so the web app doesn't pull a server dep into the
// browser bundle. If you change the server-side event shape, change
// this in lockstep.
export interface SyncEvent {
  readonly kind: "sync";
  readonly tenantId: string;
  readonly accountId: string;
  readonly counts: {
    readonly fetched: number;
    readonly inserted: number;
    readonly updated: number;
    readonly deleted: number;
  };
  readonly at: string;
}

// Mirrors `MutationSubjectKind` from packages/server/src/events.ts.
// Lets calendar/thread/comment listeners narrow without parsing the
// embedded command type.
export type RealtimeMutationSubjectKind =
  | "thread"
  | "message"
  | "comment"
  | "event"
  | "calendar"
  | "other";

export interface MutationEvent {
  readonly kind: "mutation";
  readonly subjectKind: RealtimeMutationSubjectKind;
  readonly mutation: unknown;
}

export type RealtimeEvent =
  | SyncEvent
  | MutationEvent
  | {
      readonly kind: "presence";
      readonly userId: string;
      readonly status: "online" | "typing" | "offline";
      readonly threadId?: string;
    };

type Listener = (event: RealtimeEvent) => void;

interface RealtimeContextValue {
  readonly subscribe: (listener: Listener) => () => void;
  readonly url: string;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

// Backoff schedule for reconnects. Capped at 30s so a long outage
// doesn't sit silently for minutes between attempts.
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15_000, 30_000];

function defaultRealtimeUrl(): string {
  // Embed mode wins: when the host (hof-os) wired up a wsBase via
  // RuntimeConfig, the realtime WS goes through the host's proxy
  // (`/api/mail/ws`), not the standalone realtime port.
  const runtime = runtimeWsBase();
  if (runtime) return runtime;
  // Vite-injected env. When unset, point at the dev WS server on the
  // same host the browser was served from. Production sets
  // VITE_MAILAI_RT_URL to the externally-reachable wss:// origin.
  const explicit = import.meta.env.VITE_MAILAI_RT_URL;
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  if (typeof window === "undefined") return "ws://127.0.0.1:1235";
  // Reuse the page's hostname but on the realtime port. Same-origin
  // wss when the page is HTTPS so cert handling Just Works.
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.hostname || "127.0.0.1";
  return `${proto}//${host}:1235`;
}

export interface RealtimeProviderProps {
  readonly children: ReactNode;
  // Override only in tests; production reads from Vite env.
  readonly url?: string;
  // Inject a fake WebSocket constructor for unit tests so we don't
  // need a live server.
  readonly wsCtor?: typeof WebSocket;
}

export function RealtimeProvider({ children, url, wsCtor }: RealtimeProviderProps) {
  const resolvedUrl = url ?? defaultRealtimeUrl();
  const listeners = useRef(new Set<Listener>());
  // Keep the socket + retry state in refs so the React tree never
  // re-renders just because the connection cycled. Hooks downstream
  // only care about events.
  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<{ attempt: number; timer: number | null }>({
    attempt: 0,
    timer: null,
  });
  const closedRef = useRef(false);

  useEffect(() => {
    closedRef.current = false;
    const Ctor = wsCtor ?? (typeof WebSocket !== "undefined" ? WebSocket : null);
    if (!Ctor) return;

    const scheduleReconnect = () => {
      if (closedRef.current) return;
      if (retryRef.current.timer !== null) return;
      const delay = BACKOFF_MS[Math.min(retryRef.current.attempt, BACKOFF_MS.length - 1)] ?? 30_000;
      retryRef.current.attempt += 1;
      retryRef.current.timer = window.setTimeout(() => {
        retryRef.current.timer = null;
        connect();
      }, delay);
    };

    const connect = () => {
      if (closedRef.current) return;
      let ws: WebSocket;
      try {
        ws = new Ctor(resolvedUrl);
      } catch (err) {
        // Invalid URL or browser-blocked. Schedule a retry and bail
        // — there's no recoverable state to clean up.
        // eslint-disable-next-line no-console
        console.warn("[realtime] failed to construct WebSocket:", err);
        scheduleReconnect();
        return;
      }
      socketRef.current = ws;
      ws.addEventListener("open", () => {
        retryRef.current.attempt = 0;
      });
      ws.addEventListener("message", (msg: MessageEvent<string>) => {
        // The server sends one event per JSON-encoded frame. We
        // tolerate parse errors so a single malformed payload from a
        // future server version doesn't tear the whole connection
        // down — better to log and keep the others flowing.
        try {
          const parsed = JSON.parse(msg.data) as RealtimeEvent;
          if (!parsed || typeof parsed !== "object" || !("kind" in parsed)) {
            return;
          }
          for (const listener of listeners.current) {
            try {
              listener(parsed);
            } catch (err) {
              // eslint-disable-next-line no-console
              console.error("[realtime] listener threw:", err);
            }
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("[realtime] dropped non-JSON frame:", err);
        }
      });
      ws.addEventListener("close", () => {
        socketRef.current = null;
        if (closedRef.current) return;
        scheduleReconnect();
      });
      ws.addEventListener("error", () => {
        // The browser fires `error` then `close`; the close handler
        // owns the reconnect. Keeping this empty avoids double-arming
        // the backoff timer.
      });
    };

    connect();
    return () => {
      closedRef.current = true;
      if (retryRef.current.timer !== null) {
        window.clearTimeout(retryRef.current.timer);
        retryRef.current.timer = null;
      }
      if (socketRef.current) {
        // Explicit close so the server immediately drops the entry
        // from its broadcaster set; without this, the next reload
        // briefly sees two ws clients per tab.
        try {
          socketRef.current.close();
        } catch {
          // ignore
        }
        socketRef.current = null;
      }
    };
  }, [resolvedUrl, wsCtor]);

  const value = useMemo<RealtimeContextValue>(
    () => ({
      url: resolvedUrl,
      subscribe: (listener) => {
        listeners.current.add(listener);
        return () => {
          listeners.current.delete(listener);
        };
      },
    }),
    [resolvedUrl],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeContextValue | null {
  return useContext(RealtimeContext);
}

// Subscribe to background `kind: "sync"` events. The handler is
// stable from the caller's perspective: the hook re-subscribes when
// `handler` changes identity, so wrap upstream callbacks in
// `useCallback` to avoid extra churn. Returns nothing — the consumer
// triggers refetches as a side effect.
export function useSyncEvents(handler: (event: SyncEvent) => void): void {
  const ctx = useRealtime();
  useEffect(() => {
    if (!ctx) return;
    const unsubscribe = ctx.subscribe((event) => {
      if (event.kind === "sync") handler(event);
    });
    return unsubscribe;
  }, [ctx, handler]);
}

// Subscribe to `kind: "mutation"` events filtered by subject kind.
// The calendar page wires this up as
//   useMutationEvents("event", () => bumpRevision());
// so a successful create/update/delete from another tab (or another
// device) reloads the visible window without polling.
export function useMutationEvents(
  subjectKind: RealtimeMutationSubjectKind,
  handler: (event: MutationEvent) => void,
): void {
  const ctx = useRealtime();
  useEffect(() => {
    if (!ctx) return;
    const unsubscribe = ctx.subscribe((event) => {
      if (event.kind !== "mutation") return;
      if (event.subjectKind !== subjectKind) return;
      handler(event);
    });
    return unsubscribe;
  }, [ctx, subjectKind, handler]);
}
