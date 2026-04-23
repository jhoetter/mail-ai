import type { ReactNode } from "react";
import { useSidebar } from "./shell";

interface Props {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /**
   * On phones/small tablets the sidebar collapses to an off-canvas
   * drawer. Setting `showSidebarToggle` (default true) renders the
   * hamburger that opens it. Pages embedded outside <Shell> can opt
   * out by passing false.
   */
  showSidebarToggle?: boolean;
}

// Slim, full-bleed page header. Sits flush at the top of the main
// column, separated from the body by a single border-b. The smaller
// (`text-sm`) title plus muted subtitle keeps the chrome out of the
// way of the actual content — the same vocabulary collaboration-ai
// uses for its ChannelHeader.
//
// On mobile (< md) the header grows a leading hamburger button that
// opens the Shell's sidebar drawer; the action cluster stays on the
// right but wraps if it gets long.
export function PageHeader({ title, subtitle, actions, showSidebarToggle = true }: Props) {
  const sidebar = useSidebar();
  return (
    <header className="flex shrink-0 items-center justify-between gap-2 border-b border-divider bg-surface px-3 py-2 sm:px-4 sm:py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        {showSidebarToggle ? (
          <button
            type="button"
            onClick={sidebar.toggle}
            aria-label="Toggle navigation"
            aria-expanded={sidebar.open}
            className="-ml-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-secondary transition-colors hover:bg-hover hover:text-foreground md:hidden"
          >
            {/* Hamburger glyph kept inline (no extra dependency) and
                sized to match Lucide icons used elsewhere in the app. */}
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
        ) : null}
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-foreground">{title}</h1>
          {subtitle && <p className="mt-0.5 truncate text-xs text-tertiary">{subtitle}</p>}
        </div>
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">{actions}</div>
      )}
    </header>
  );
}
