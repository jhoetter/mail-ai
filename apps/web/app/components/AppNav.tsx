"use client";

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

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { LocaleToggle } from "../lib/i18n/LocaleToggle";
import { useTranslator } from "../lib/i18n/useTranslator";

interface NavItem {
  href: string;
  // i18n key into `nav.*`. Resolved at render time so language
  // switches re-paint the sidebar without remounting.
  labelKey: string;
  // Right-aligned hint shown in muted text (e.g. shortcut, count,
  // "soon"). Same i18n treatment as labelKey when present.
  hintKey?: string;
}

interface NavSection {
  labelKey: string;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  {
    labelKey: "nav.workspace",
    items: [
      { href: "/inbox", labelKey: "nav.inbox" },
      { href: "/search", labelKey: "nav.search" },
    ],
  },
  {
    labelKey: "nav.settings",
    items: [
      { href: "/settings/account", labelKey: "nav.accounts" },
      { href: "/settings/inboxes", labelKey: "nav.inboxes", hintKey: "nav.soon" },
      { href: "/settings/audit", labelKey: "nav.auditLog", hintKey: "nav.soon" },
    ],
  },
];

export function AppNav() {
  const pathname = usePathname();
  const { t } = useTranslator();
  return (
    <nav className="flex h-full flex-col gap-6 text-sm">
      <div className="flex items-center gap-2 px-2 pt-1">
        <Link href="/inbox" className="font-semibold tracking-tight">
          {t("common.appName")}
        </Link>
      </div>
      {SECTIONS.map((section) => (
        <div key={section.labelKey} className="flex flex-col gap-1">
          <div className="px-2 text-[11px] uppercase tracking-wider text-muted">
            {t(section.labelKey)}
          </div>
          {section.items.map((item) => (
            <NavLink
              key={item.href}
              href={item.href}
              label={t(item.labelKey)}
              {...(item.hintKey ? { hint: t(item.hintKey) } : {})}
              active={isActive(pathname, item.href)}
            />
          ))}
        </div>
      ))}
      <div className="mt-auto flex items-center justify-between px-2 pb-1 text-[11px] text-muted">
        <span>{t("common.version")}</span>
        <LocaleToggle compact />
      </div>
    </nav>
  );
}

function NavLink({
  href,
  label,
  hint,
  active,
}: {
  href: string;
  label: string;
  hint?: string;
  active: boolean;
}): ReactNode {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={
        "flex items-center justify-between rounded-md px-2 py-1.5 transition-colors " +
        (active
          ? "bg-bg text-fg font-medium"
          : "text-muted hover:bg-bg hover:text-fg")
      }
    >
      <span>{label}</span>
      {hint ? (
        <span className="text-[10px] uppercase tracking-wider text-muted">{hint}</span>
      ) : null}
    </Link>
  );
}

// Active when the URL exactly matches OR is a sub-path. We special-case
// "/" so it never marks every link active.
function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}
