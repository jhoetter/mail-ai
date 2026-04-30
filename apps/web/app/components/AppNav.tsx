// Single source of truth for the left-rail navigation. Every page
// renders <Shell sidebar={<AppNav />}> so links don't disappear or
// reshuffle when the user navigates between routes — that was the
// thing making the product feel "unintuitive": each page had its own
// hand-rolled <nav> with a different subset of links, and several of
// those links pointed to non-existent routes (404).
//
// Sections (top → bottom):
//   - WORKSPACE: the day-to-day surfaces a user lives in
//   - SETTINGS:  configuration that's done occasionally
//
// Adding a new top-level page? Add it here, ship a real (or honestly
// labeled "coming soon") page at the same path, and it'll appear in
// the sidebar across every screen automatically.

import { Link, useLocation, useSearchParams } from "react-router";
import { useEffect, useState, type ReactNode } from "react";
import { ThemeToggle, useSidebar } from "@mailai/ui";
import {
  Archive,
  Ban,
  Calendar,
  CheckCircle2,
  BriefcaseBusiness,
  FileText,
  Folder,
  Home,
  Inbox as InboxIcon,
  Mail,
  MessageCircle,
  Moon,
  Send,
  Trash2,
  User,
  type LucideIcon,
} from "lucide-react";
import { LocaleToggle } from "../lib/i18n/LocaleToggle";
import { useTranslator } from "../lib/i18n/useTranslator";
import { useChrome } from "../lib/shell/ChromeContext";
import { usePaletteRegistry } from "../lib/shell/paletteRegistry";
import { listViews, type ViewSummary } from "../lib/views-client";

interface NavItem {
  href: string;
  // i18n key into `nav.*`. Resolved at render time so language
  // switches re-paint the sidebar without remounting.
  labelKey: string;
  // Right-aligned hint shown in muted text (e.g. shortcut, count,
  // "soon"). Same i18n treatment as labelKey when present.
  hintKey?: string;
  // Lucide icon component shown in the left rail. Keeps the rail
  // skim-able the same way Notion / Front / office-ai do it.
  icon: LucideIcon;
}

interface NavSection {
  labelKey: string;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  {
    labelKey: "nav.calendar",
    items: [{ href: "/calendar", labelKey: "nav.calendar", icon: Calendar }],
  },
  {
    labelKey: "nav.settings",
    items: [{ href: "/settings/account", labelKey: "nav.accounts", icon: User }],
  },
];

const GLOBAL_APP_LINKS = [
  { id: "os", label: "App", href: "http://localhost:3000/", icon: Home },
  { id: "hofos", label: "hofOS", href: "http://localhost:3600/customers", icon: BriefcaseBusiness },
  { id: "mailai", label: "Mail", href: "http://localhost:3010/inbox", icon: Mail },
  { id: "collabai", label: "Chat", href: "http://localhost:8010/", icon: MessageCircle },
  { id: "driveai", label: "Drive", href: "http://localhost:3520/drive/home", icon: Folder },
  { id: "pagesai", label: "Pages", href: "http://localhost:3399/pages", icon: FileText },
] as const;

// View name → lucide icon. The server stores an emoji per view but
// the rest of the sidebar uses lucide outline icons; mapping by name
// keeps the look consistent. Custom views (any name not in this
// table) fall back to InboxIcon.
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

export function AppNav({ onNavigate }: { onNavigate?: () => void } = {}) {
  // React Router's useLocation gives us the current pathname so we can
  // mark the active row. We also auto-dismiss the mobile sidebar
  // drawer whenever the user picks a destination — on desktop this
  // is a no-op because the drawer is already closed.
  const pathname = useLocation().pathname;
  const sidebar = useSidebar();
  const handleNavigate = () => {
    sidebar.close();
    onNavigate?.();
  };
  const { t } = useTranslator();
  const palette = usePaletteRegistry();
  const chrome = useChrome();
  // The "mail-ai · ⌘K" header opens our local palette. In embedded
  // mode (`chrome="content"`) the host already shows its own ⌘K hint
  // *and* owns the palette, so the second one was visual noise (and
  // pressing it popped a separate overlay). Hide both the brand label
  // and the button so the rail starts at the section list directly.
  const showBrandHeader = chrome === "full";
  return (
    <nav className="flex h-full flex-col text-sm">
      {showBrandHeader && (
        <div className="flex shrink-0 flex-col gap-2 border-b border-divider px-3 py-3">
          <Link
            to="/inbox"
            onClick={handleNavigate}
            className="flex items-center gap-2 truncate text-[15px] font-semibold tracking-tight text-foreground"
          >
            <Mail size={16} aria-hidden className="shrink-0" />
            <span>Mail</span>
          </Link>
          <button
            type="button"
            onClick={() => palette.open()}
            className="flex items-center justify-between rounded-md border border-divider bg-background px-3 py-2 text-left text-sm font-medium text-secondary transition-colors hover:border-foreground/30 hover:text-foreground"
            aria-label={t("palette.title")}
            title={t("palette.title")}
          >
            <span>Actions</span>
            <span>⌘K</span>
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 py-2">
        <MailViewsNav onNavigate={handleNavigate} />
        {SECTIONS.map((section) => (
          <div key={section.labelKey} className="flex flex-col gap-0.5">
            <div className="px-2 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-tertiary">
              {t(section.labelKey)}
            </div>
            {section.items.map((item) => (
              <NavLink
                key={item.href}
                href={item.href}
                label={t(item.labelKey)}
                icon={item.icon}
                {...(item.hintKey ? { hint: t(item.hintKey) } : {})}
                active={isActive(pathname, item.href)}
                onNavigate={handleNavigate}
              />
            ))}
          </div>
        ))}
        <ThemeToggle
          labels={{
            light: t("theme.light"),
            dark: t("theme.dark"),
            system: t("theme.system"),
          }}
        />
        <div className="flex items-center justify-between px-1">
          <span>{t("common.version")}</span>
          <LocaleToggle compact />
        </div>
      </div>
      <div className="shrink-0 border-t border-divider px-2 py-2">
        <div className="px-2 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-tertiary">
          Apps
        </div>
        {GLOBAL_APP_LINKS.map((app) => {
          const Icon = app.icon;
          return (
            <a
              key={app.id}
              href={app.href}
              className={
                "flex items-center gap-2 rounded-md px-2 py-1 transition-colors " +
                (app.id === "mailai"
                  ? "bg-hover font-medium text-foreground"
                  : "text-secondary hover:bg-hover hover:text-foreground")
              }
            >
              <Icon
                size={14}
                aria-hidden
                className={"shrink-0 " + (app.id === "mailai" ? "text-foreground" : "text-tertiary")}
              />
              <span className="truncate">{app.label}</span>
            </a>
          );
        })}
      </div>
      <div className="flex shrink-0 flex-col gap-1.5 border-t border-divider px-2 py-2 text-[11px] text-tertiary">
        <div className="flex items-center gap-2 rounded-md px-1.5 py-1.5 text-secondary hover:bg-hover hover:text-foreground">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-foreground text-[11px] font-semibold text-background">
            MA
          </span>
          <span className="min-w-0 flex-1 truncate text-xs">Mail user</span>
        </div>
      </div>
    </nav>
  );
}

function NavLink({
  href,
  label,
  hint,
  active,
  icon: Icon,
  onNavigate,
}: {
  href: string;
  label: string;
  hint?: string;
  active: boolean;
  icon: LucideIcon;
  onNavigate?: () => void;
}): ReactNode {
  return (
    <Link
      to={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={
        "flex items-center justify-between gap-2 rounded-md px-2 py-1 transition-colors " +
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
      {hint ? (
        <span className="text-[10px] uppercase tracking-wider text-tertiary">{hint}</span>
      ) : null}
    </Link>
  );
}

// Active when the URL exactly matches OR is a sub-path. We special-case
// "/" so it never marks every link active.
function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}

// Mail views ("Inbox", "Drafts", "Sent", "Snoozed", "Done", "Trash",
// "Spam", "All Mail" by default) live in the sidebar so the inbox
// surface itself stays focused on the thread list. Each entry
// navigates to /inbox?view=<id>.
//
// There is intentionally no "all threads" entry here — pick one of
// the views to see anything. /inbox without a view param still works
// for direct links, but isn't surfaced in navigation.
//
// We fetch views once per mount; they change rarely (settings page
// is the only producer) and a stale entry just means a slightly
// out-of-date label until the next route change.
function MailViewsNav({ onNavigate }: { onNavigate: () => void }) {
  const { t } = useTranslator();
  const pathname = useLocation().pathname;
  const [params] = useSearchParams();
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

  const onInbox = pathname === "/inbox" || pathname.startsWith("/inbox/");
  const activeViewId = onInbox ? params.get("view") : null;
  const sorted = (views ?? []).slice().sort((a, b) => a.position - b.position);

  return (
    <div className="flex flex-col gap-0.5">
      <div className="px-2 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-tertiary">
        {t("nav.email")}
      </div>
      {sorted.map((view) => {
        const Icon = VIEW_ICONS[view.name] ?? InboxIcon;
        return (
          <NavLink
            key={view.id}
            href={`/inbox?view=${encodeURIComponent(view.id)}`}
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
