/**
 * Runtime configuration seam for the mail-ai web client.
 *
 * The same React tree under `apps/web/app/*` can run in two contexts:
 *
 * 1. **Standalone** — `apps/web/src/main.tsx` mounts the routes directly
 *    against the mail-ai server (origin-relative `/api/*`, ws on
 *    `:1235`, no auth headers — the server trusts the local browser).
 * 2. **hofOS native module** — the data-app mounts the same routes,
 *    proxies `/api/mail/*` to the sidecar, and attaches the current
 *    `hof_token` to proxied requests.
 *
 * Both modes converge on this module: a module-level singleton holds
 * the current config, and the standalone or hofOS root sets it once on
 * mount via `setRuntimeConfig`. Lib modules (`api.ts`, `realtime.tsx`,
 * every `*-client.ts`) read from here when building URLs / fetch
 * options.
 *
 * The setter is intentionally module-level rather than React-context
 * only because most client modules export plain async functions that
 * cannot reach into a React context. A lightweight `<RuntimeConfigProvider>`
 * wrapper sets/clears the singleton on mount/unmount and re-renders the
 * tree if the config identity changes.
 */
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";

export interface RuntimeIdentity {
  readonly id: string;
  readonly name: string;
  readonly email?: string;
}

/**
 * The single seam between the standalone web app and the hofOS shell.
 * All values are optional so the standalone defaults still work
 * when `setRuntimeConfig` was never called.
 */
export interface RuntimeConfig {
  /** Base URL prepended to every API path. `""` = origin-relative. */
  readonly apiBase: string;
  /** Optional WebSocket base. `undefined` = use the standalone default. */
  readonly wsBase?: string;
  /** Identity carried in JWT claims; used for presence + audit. */
  readonly identity?: RuntimeIdentity;
  /** Workspace / tenant id (= JWT `tid` claim). */
  readonly workspaceId?: string;
  /**
   * Returns a bearer token to attach as `Authorization: Bearer ...`.
   * Standalone: returns `""` (no auth header attached).
   * hofOS: returns the current `hof_token`; the data-app proxy mints
   * the upstream sidecar JWT.
   */
  getAuthToken(): Promise<string>;
}

let _config: RuntimeConfig | null = null;

export function setRuntimeConfig(next: RuntimeConfig | null): void {
  _config = next;
}

export function getRuntimeConfig(): RuntimeConfig | null {
  return _config;
}

/**
 * Resolved API base. Falls back to the legacy `VITE_MAILAI_API_URL`
 * env so existing standalone deployments keep working unchanged.
 */
export function runtimeApiBase(): string {
  if (_config && typeof _config.apiBase === "string") return _config.apiBase;
  if (isHofMailRoute()) return "/api/mail";
  return (import.meta.env?.VITE_MAILAI_API_URL as string | undefined) ?? "";
}

/**
 * Resolved WebSocket base, or `null` to defer to the caller's default.
 */
export function runtimeWsBase(): string | null {
  if (_config && typeof _config.wsBase === "string") return _config.wsBase;
  if (isHofMailRoute()) return wsBase("/api/mail");
  return null;
}

/**
 * Auth headers to merge into every request issued by the lib clients.
 * Returns an empty object in standalone mode so we don't accidentally
 * send `Authorization: Bearer ` (empty) headers.
 */
export async function runtimeAuthHeaders(): Promise<Record<string, string>> {
  if (!_config) {
    const token = readHofToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  }
  try {
    const token = await _config.getAuthToken();
    if (!token) return {};
    return { authorization: `Bearer ${token}` };
  } catch {
    return {};
  }
}

const RuntimeConfigContext = createContext<RuntimeConfig | null>(null);

export interface RuntimeConfigProviderProps {
  readonly runtime: RuntimeConfig | null;
  readonly children: ReactNode;
}

/**
 * React-side mirror of the singleton. Mounting this provider sets the
 * module-level `_config` so plain-function clients see it; unmounting
 * clears it so a tab can host both standalone + hofOS trees without
 * leaking state.
 *
 * IMPORTANT: the assignment runs *during render*, not in a `useEffect`.
 * Children (e.g. `RealtimeProvider`, every `*-client.ts`) read the
 * singleton during their own render via `runtimeApiBase()` /
 * `runtimeWsBase()`. If we deferred the assignment to a mount effect,
 * the first render would see `null` and resolve to the standalone
 * defaults — producing `/api/threads` against hof-os's data-app
 * (404 HTML, "Unexpected token '<'") and `ws://host/ws` instead of
 * `ws://host/api/mail/ws` (proxy 404, retry storm). React allows
 * synchronous module-level state writes during render as long as
 * they're idempotent for a given input, which they are here.
 * Cleanup still runs in `useEffect` to fire on unmount.
 */
export function RuntimeConfigProvider({ runtime, children }: RuntimeConfigProviderProps) {
  if (_config !== runtime) {
    setRuntimeConfig(runtime);
  }
  useEffect(() => {
    setRuntimeConfig(runtime);
    return () => {
      if (getRuntimeConfig() === runtime) {
        setRuntimeConfig(null);
      }
    };
  }, [runtime]);
  const value = useMemo(() => runtime, [runtime]);
  return createElement(RuntimeConfigContext.Provider, { value }, children);
}

export function useRuntimeConfig(): RuntimeConfig | null {
  return useContext(RuntimeConfigContext);
}

function isHofMailRoute(): boolean {
  // Fallback only: the native route should provide RuntimeConfig.
  // This keeps direct page refreshes from leaking standalone URLs if
  // the provider is not mounted yet.
  if (typeof window === "undefined") return false;
  return (
    window.location.pathname === "/mail" ||
    window.location.pathname.startsWith("/mail/") ||
    window.location.pathname === "/calendar" ||
    window.location.pathname.startsWith("/calendar/")
  );
}

function readHofToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem("hof_token");
  } catch {
    return null;
  }
}

function wsBase(path: string): string {
  if (typeof window === "undefined") return path;
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}${path}`;
}
