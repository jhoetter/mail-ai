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

import { Link, useLocation } from "react-router";
import type { ReactNode } from "react";
import { ThemeToggle, useSidebar } from "@mailai/ui";
import {
  Calendar,
  FileText,
  Inbox as InboxIcon,
  Mailbox,
  ScrollText,
  Search,
  Tag,
  User,
  type LucideIcon,
} from "lucide-react";
import { LocaleToggle } from "../lib/i18n/LocaleToggle";
import { useTranslator } from "../lib/i18n/useTranslator";
import { usePaletteRegistry } from "../lib/shell";

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
    labelKey: "nav.workspace",
    items: [
      { href: "/inbox", labelKey: "nav.inbox", icon: InboxIcon },
      { href: "/drafts", labelKey: "nav.drafts", icon: FileText },
      { href: "/calendar", labelKey: "nav.calendar", icon: Calendar },
      { href: "/search", labelKey: "nav.search", icon: Search },
    ],
  },
  {
    labelKey: "nav.settings",
    items: [
      { href: "/settings/account", labelKey: "nav.accounts", icon: User },
      { href: "/settings/tags", labelKey: "nav.tags", icon: Tag },
      { href: "/settings/inboxes", labelKey: "nav.inboxes", icon: Mailbox },
      { href: "/settings/audit", labelKey: "nav.auditLog", icon: ScrollText },
    ],
  },
];

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
  return (
    <nav className="flex h-full flex-col text-sm">
      <div className="flex shrink-0 items-center gap-2 border-b border-divider px-3 py-2.5">
        <Link
          to="/inbox"
          onClick={handleNavigate}
          className="truncate text-sm font-semibold tracking-tight text-foreground"
        >
          {t("common.appName")}
        </Link>
        <button
          type="button"
          onClick={() => palette.open()}
          className="ml-auto inline-flex items-center gap-1 rounded border border-divider bg-background px-1.5 py-0.5 text-[10px] font-medium text-secondary transition-colors hover:border-foreground/30 hover:text-foreground"
          aria-label={t("palette.title")}
          title={t("palette.title")}
        >
          <span>⌘K</span>
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 py-2">
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
      </div>
      <div className="flex shrink-0 flex-col gap-1.5 border-t border-divider px-2 py-2 text-[11px] text-tertiary">
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
