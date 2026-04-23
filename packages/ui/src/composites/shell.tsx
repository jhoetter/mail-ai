import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface Props {
  /**
   * Pass `null` or omit to render content-only (no left rail). Used when
   * the host already supplies its own navigation (e.g. mail-ai embedded
   * in hof-os, where the host's sidebar would otherwise overlap).
   */
  sidebar?: ReactNode;
  children: ReactNode;
}

// ──────────────────────────────────────────────────────────────────────
// Sidebar visibility context
//
// On desktop (≥ md) the sidebar is a permanent left rail. On phone
// and small-tablet viewports it becomes an off-canvas drawer that
// slides in over the content. Consumers — most importantly the
// PageHeader's hamburger button — call `useSidebar().toggle()` to
// open/close it without prop-drilling state through every page.
//
// The context is mounted by <Shell>, so anything rendered inside it
// has access. Outside (e.g. a marketing page that isn't in the app
// shell) the hook returns a no-op so consumers don't crash.
// ──────────────────────────────────────────────────────────────────────

interface SidebarApi {
  readonly open: boolean;
  readonly toggle: () => void;
  readonly close: () => void;
}

const NOOP_SIDEBAR: SidebarApi = {
  open: false,
  toggle: () => {},
  close: () => {},
};

const SidebarContext = createContext<SidebarApi>(NOOP_SIDEBAR);

export function useSidebar(): SidebarApi {
  return useContext(SidebarContext);
}

// ──────────────────────────────────────────────────────────────────────
// Shell
//
// Two-mode layout:
//   • mobile/tablet (< md): single-column. Sidebar is off-canvas,
//     pulled in via a translate-x animation, with a backdrop scrim
//     that closes the drawer when tapped.
//   • desktop (≥ md): two-column grid (240px rail + content).
//
// Single 1px divider vocabulary preserved across both — the only
// real change is whether the rail is visible alongside the content
// or stacked above it.
// ──────────────────────────────────────────────────────────────────────
export function Shell({ sidebar, children }: Props) {
  const [open, setOpen] = useState(false);

  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((prev) => !prev), []);

  // Close the drawer on Escape — standard expectation for any
  // overlay panel and one less reason to need to tap-away.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Lock body scroll while the drawer is open on mobile so the page
  // beneath doesn't jiggle when the user scrolls the drawer itself.
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const api = useMemo<SidebarApi>(() => ({ open, toggle, close }), [open, toggle, close]);

  // Headless / embedded mode: no rail at all. We still mount the
  // SidebarContext.Provider with the no-op shape so any descendant
  // hamburger button is a no-op rather than crashing.
  if (sidebar == null) {
    return (
      <SidebarContext.Provider value={api}>
        <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
          <main className="flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden">{children}</main>
        </div>
      </SidebarContext.Provider>
    );
  }

  return (
    <SidebarContext.Provider value={api}>
      <div className="flex h-full min-h-0 bg-background text-foreground md:grid md:grid-cols-[240px_1fr]">
        {/*
          Sidebar
          ───────
          • Desktop: in-flow, takes the first grid column.
          • Mobile: position fixed, slides in from the left. The
            translate transition is GPU-friendly and avoids reflow.
          • The width on mobile uses min(85vw, 320px) so the rail
            never eats the entire screen on narrow phones, but
            also doesn't look cramped on tablets in portrait.
        */}
        <aside
          className={
            "fixed inset-y-0 left-0 z-40 flex w-[min(85vw,320px)] min-h-0 flex-col overflow-y-auto border-r border-divider bg-surface " +
            "transition-transform duration-200 ease-out " +
            (open ? "translate-x-0" : "-translate-x-full") +
            " md:static md:z-auto md:w-auto md:translate-x-0"
          }
          aria-hidden={!open ? undefined : false}
        >
          {sidebar}
        </aside>

        {/*
          Backdrop scrim — only painted on mobile while the drawer is
          open. Tapping it closes the drawer.
        */}
        {open ? (
          <button
            type="button"
            aria-label="Close navigation"
            onClick={close}
            className="fixed inset-0 z-30 bg-black/40 md:hidden"
          />
        ) : null}

        <main className="flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden">{children}</main>
      </div>
    </SidebarContext.Provider>
  );
}
