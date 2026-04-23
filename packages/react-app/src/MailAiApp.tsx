// MailAiApp: the single embeddable component used by hof-os (and any
// future host) to mount the Inbox / Calendar / Drafts pages inside a
// foreign React tree.
//
// Mechanics:
//
// - `AppProviders` wires up the same Theme / I18n / Dialogs / Realtime
//   stack the standalone `apps/web/src/main.tsx` uses, plus a
//   `RuntimeConfigProvider` derived from the host's `MailaiHostHooks`.
//   That single seam makes every `apiFetch(...)` call route through
//   the host's proxy and attach a JWT.
// - `MemoryRouter` keeps the embed's URL state internal (so the host's
//   own router stays untouched) while letting `AppShell` continue to
//   use `useNavigate()` for command-palette deep-links.
// - `surface` selects the initial route: hof-os mounts the embed
//   twice — once at `/mail` (surface="inbox") and once at `/calendar`
//   (surface="calendar") — so each sidebar entry lands on the right
//   page out of the box.
//
// The legacy `MailAiHostContext` from v0.1 is gone: its only field
// was the host hooks, and those now live on `RuntimeConfig`. Anyone
// who needs the runtime can call `useRuntimeConfig()`.

import { useMemo } from "react";
import { MemoryRouter, Navigate, Route, Routes } from "react-router";

import { AppShell, type AppShellChrome } from "@/lib/shell";
import type { RuntimeConfig, RuntimeIdentity } from "@/lib/runtime-config";

import InboxPage from "@/inbox/page";
import CalendarPage from "@/calendar/page";
import DraftsPage from "@/drafts/page";

import { AppProviders } from "./AppProviders.js";
import type { AuthToken, MailaiHostHooks } from "./contract.js";

export type MailAiSurface = "inbox" | "calendar" | "drafts";

export interface MailAiAppProps {
  readonly hooks: MailaiHostHooks;
  /** Which page to land on when the embed first mounts. */
  readonly surface?: MailAiSurface;
  /** Optional deep-link to a specific thread (only meaningful for inbox). */
  readonly initialThreadId?: string;
  /**
   * Visual chrome mode forwarded to {@link AppShell}.
   *
   * - `"full"` (default) renders the standalone chrome (TopBar with
   *   global search). Match the legacy v0.1 behaviour.
   * - `"content"` drops the TopBar so a host (e.g. hof-os) can supply
   *   its own sidebar / header without a duplicated search row.
   *   Palette + ⌘K + error toast are still mounted.
   */
  readonly chrome?: AppShellChrome;
}

const SURFACE_ROUTES: Record<MailAiSurface, string> = {
  inbox: "/inbox",
  calendar: "/calendar",
  drafts: "/drafts",
};

export function MailAiApp({
  hooks,
  surface = "inbox",
  initialThreadId,
  chrome = "full",
}: MailAiAppProps) {
  const runtime = useMemo<RuntimeConfig>(
    () => runtimeConfigFromHooks(hooks),
    // hooks is a stable reference at the host (it's a `useMemo` over
    // identity + token-getter); re-deriving on identity change is the
    // right behaviour because that means the host swapped users.
    [hooks],
  );

  const initialEntry = buildInitialEntry(surface, initialThreadId);

  return (
    <AppProviders runtime={runtime}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AppShell chrome={chrome}>
          <Routes>
            <Route path="/inbox" element={<InboxPage />} />
            <Route path="/calendar" element={<CalendarPage />} />
            <Route path="/drafts" element={<DraftsPage />} />
            <Route path="*" element={<Navigate to={SURFACE_ROUTES[surface]} replace />} />
          </Routes>
        </AppShell>
      </MemoryRouter>
    </AppProviders>
  );
}

function buildInitialEntry(surface: MailAiSurface, threadId?: string): string {
  const base = SURFACE_ROUTES[surface];
  if (surface === "inbox" && threadId) {
    return `${base}?thread=${encodeURIComponent(threadId)}`;
  }
  return base;
}

/**
 * Convert the v0.1 host-hooks contract into a `RuntimeConfig`. The
 * mapping is mostly verbatim; the one nuance is that `onAuth()`
 * returns a `{ token, expiresAt }` envelope but the runtime only
 * needs the bearer string, so we unwrap and let the host own caching.
 */
function runtimeConfigFromHooks(hooks: MailaiHostHooks): RuntimeConfig {
  const identity: RuntimeIdentity = {
    id: hooks.presenceUser.id,
    name: hooks.presenceUser.name,
  };
  const cfg: RuntimeConfig = {
    apiBase: stripTrailingSlash(hooks.apiUrl),
    identity,
    async getAuthToken(): Promise<string> {
      const t: AuthToken = await hooks.onAuth();
      return t.token;
    },
  };
  // Only attach wsBase when the host actually provided one — under
  // exactOptionalPropertyTypes, assigning `undefined` to a key marked
  // `?: string` is forbidden, so we conditionally spread instead.
  if (hooks.wsUrl) {
    return { ...cfg, wsBase: hooks.wsUrl };
  }
  return cfg;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
