// MailAiViewNav — headless extraction of the `MailViewsNav` block
// from `apps/web/app/components/AppNav.tsx`. Renders the Inbox /
// Drafts / Sent / Snoozed / Done / Trash picker that reads from
// `listViews()` and links into `/inbox?view=<id>`.
//
// Composability contract (Phase A):
//   - Router-free: uses plain `<button>` + `onNavigate` so the host
//     can mount this in *any* slot (a portal-ed sub-sidebar, a
//     command palette section, a sheet) without forcing a router
//     context. The host owns navigation; we only emit intent.
//   - Active state is supplied by the host via `activePath`. When
//     omitted we fall back to "no row active", which is correct for
//     hosts that haven't started mirroring routes yet.
//   - Requires the host to wrap the surrounding tree in
//     `MailAiProvider` so `listViews()` resolves through the
//     runtime config (api base + auth token).
//   - Visual styling matches the standalone shell so embed +
//     standalone are pixel-equivalent when the host renders the
//     same `bg-surface` / `border-divider` tokens.

import { useEffect, useState, type ReactNode } from "react";
import {
  Archive,
  Ban,
  CheckCircle2,
  FileText,
  Inbox as InboxIcon,
  Moon,
  Send,
  Trash2,
  type LucideIcon,
} from "lucide-react";

import { listViews, type ViewSummary } from "@/lib/views-client";

// Mirror the standalone AppNav's icon mapping so embed + standalone
// share their visual vocabulary. Custom view names (anything not in
// this table) fall back to the generic InboxIcon.
const VIEW_ICONS: Record<string, LucideIcon> = {
  Inbox: InboxIcon,
  Drafts: FileText,
  Sent: Send,
  Snoozed: Moon,
  Done: CheckCircle2,
  Trash: Trash2,
  Spam: Ban,
  "All Mail": Archive,
};

export interface MailAiViewNavProps {
  /**
   * Path the host is currently displaying inside the embedded inbox
   * pane (e.g. `/inbox?view=foo`). Used to highlight the matching
   * row. Defaults to no active row.
   */
  readonly activePath?: string;
  /**
   * Fired with the target href whenever the user picks a view.
   * The host is responsible for re-mounting / updating the embedded
   * pane with the new `initialPath`.
   */
  readonly onNavigate?: (path: string) => void;
}

export function MailAiViewNav({ activePath, onNavigate }: MailAiViewNavProps) {
  const [views, setViews] = useState<ViewSummary[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    listViews()
      .then((rows) => !cancelled && setViews(rows))
      .catch(() => !cancelled && setViews([]));
    return () => {
      cancelled = true;
    };
  }, []);

  const { onInbox, activeViewId } = parseActivePath(activePath);
  const sorted = (views ?? []).slice().sort((a, b) => a.position - b.position);

  return (
    <div className="flex flex-col gap-0.5">
      {sorted.map((view) => {
        const Icon = VIEW_ICONS[view.name] ?? InboxIcon;
        const href = `/inbox?view=${encodeURIComponent(view.id)}`;
        return (
          <NavRow
            key={view.id}
            href={href}
            label={view.name}
            icon={Icon}
            active={onInbox && activeViewId === view.id}
            onNavigate={onNavigate}
          />
        );
      })}
    </div>
  );
}

function parseActivePath(activePath: string | undefined): {
  onInbox: boolean;
  activeViewId: string | null;
} {
  if (!activePath) return { onInbox: false, activeViewId: null };
  const [pathname, query] = activePath.split("?", 2);
  const onInbox = pathname === "/inbox" || (pathname?.startsWith("/inbox/") ?? false);
  if (!onInbox) return { onInbox, activeViewId: null };
  if (!query) return { onInbox, activeViewId: null };
  const params = new URLSearchParams(query);
  return { onInbox, activeViewId: params.get("view") };
}

interface NavRowProps {
  href: string;
  label: string;
  active: boolean;
  icon: LucideIcon;
  onNavigate?: ((path: string) => void) | undefined;
}

export function NavRow({ href, label, active, icon: Icon, onNavigate }: NavRowProps): ReactNode {
  return (
    <button
      type="button"
      onClick={() => onNavigate?.(href)}
      aria-current={active ? "page" : undefined}
      className={
        "flex items-center justify-between gap-2 rounded-md px-2 py-1 text-sm text-left transition-colors " +
        (active
          ? "bg-hover font-medium text-foreground"
          : "text-secondary hover:bg-hover hover:text-foreground")
      }
    >
      <span className="flex min-w-0 items-center gap-2">
        <Icon
          size={14}
          aria-hidden
          className={"shrink-0 " + (active ? "text-foreground" : "text-tertiary")}
        />
        <span className="truncate">{label}</span>
      </span>
    </button>
  );
}
