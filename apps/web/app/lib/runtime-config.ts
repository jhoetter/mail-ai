/**
 * Runtime configuration seam for the mail-ai web client.
 *
 * The same React tree under `apps/web/app/*` runs in two contexts:
 *
 * 1. **Standalone** — `apps/web/src/main.tsx` mounts the routes directly
 *    against the mail-ai server (origin-relative `/api/*`, ws on
 *    `:1235`, no auth headers — the server trusts the local browser).
 * 2. **Embedded** — `packages/react-app/src/MailAiApp.tsx` mounts the
 *    same routes inside hof-os, which proxies `/api/mail/*` to a
 *    sidecar and mints short-lived JWTs the embed must attach to every
 *    request. The hooks contract (`MailaiHostHooks`) provides the
 *    `apiUrl`, `wsUrl`, identity, and `onAuth` callback.
 *
 * Both modes converge on this module: a module-level singleton holds
 * the current config, and the standalone or embed root sets it once on
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
 * The single seam between the standalone web app and the embedded
 * shell. All values are optional so the standalone defaults still work
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
   * Embed: calls `hooks.onAuth()` and caches; the helper deals with
   * refresh on its own — this function only returns the current token.
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
  return (import.meta.env?.VITE_MAILAI_API_URL as string | undefined) ?? "";
}

/**
 * Resolved WebSocket base, or `null` to defer to the caller's default.
 */
export function runtimeWsBase(): string | null {
  if (_config && typeof _config.wsBase === "string") return _config.wsBase;
  return null;
}

/**
 * Auth headers to merge into every request issued by the lib clients.
 * Returns an empty object in standalone mode so we don't accidentally
 * send `Authorization: Bearer ` (empty) headers.
 */
export async function runtimeAuthHeaders(): Promise<Record<string, string>> {
  if (!_config) return {};
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
 * clears it so a tab can host both standalone + embed trees without
 * leaking state.
 */
export function RuntimeConfigProvider({ runtime, children }: RuntimeConfigProviderProps) {
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
