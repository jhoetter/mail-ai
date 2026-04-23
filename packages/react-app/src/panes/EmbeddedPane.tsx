// EmbeddedPane — shared MemoryRouter + onNavigate-mirror plumbing
// behind every Phase-A content pane (`MailAiInbox`, `MailAiThread`,
// `MailAiCompose`, `MailAiCalendar`).
//
// The contract is:
//
//   - Host picks an `initialPath` (e.g. `/inbox?view=foo`); we seed
//     the MemoryRouter with that single entry so deep-links survive
//     a remount.
//   - Inner components keep using `useNavigate()` / `Link` from
//     react-router; the inner navigation never escapes into the
//     host's `BrowserRouter`.
//   - `onNavigate(path)` fires every time the memory router's
//     location changes, so the host can mirror the embed URL into
//     its own router and keep deep-linkable bookmarks working.
//
// We use a tiny inner component (`LocationMirror`) because
// `useLocation` only resolves *inside* the `MemoryRouter`. Pulling
// it out at the pane level would crash the host's router context.

import { useEffect, type ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router";

export interface EmbeddedPaneProps {
  readonly initialPath?: string;
  readonly onNavigate?: (path: string) => void;
}

interface InternalProps extends EmbeddedPaneProps {
  readonly defaultPath: string;
  readonly children: ReactNode;
}

export function EmbeddedPane({
  initialPath,
  onNavigate,
  defaultPath,
  children,
}: InternalProps) {
  const initialEntry = initialPath ?? defaultPath;
  return (
    <div className="relative h-full min-h-0 w-full">
      <MemoryRouter initialEntries={[initialEntry]}>
        {onNavigate ? <LocationMirror onNavigate={onNavigate} /> : null}
        {children}
      </MemoryRouter>
    </div>
  );
}

function LocationMirror({ onNavigate }: { onNavigate: (path: string) => void }) {
  const location = useLocation();
  useEffect(() => {
    const path = location.pathname + (location.search || "") + (location.hash || "");
    onNavigate(path);
  }, [location.pathname, location.search, location.hash, onNavigate]);
  return null;
}
