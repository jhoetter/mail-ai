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

interface NavItem {
  href: string;
  label: string;
  // Right-aligned hint shown in muted text (e.g. shortcut, count,
  // "soon"). Kept narrow so we don't reinvent a badge component yet.
  hint?: string;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  {
    label: "Workspace",
    items: [
      { href: "/inbox", label: "Inbox" },
      { href: "/search", label: "Search" },
    ],
  },
  {
    label: "Settings",
    items: [
      { href: "/settings/account", label: "Accounts" },
      { href: "/settings/inboxes", label: "Inboxes", hint: "soon" },
      { href: "/settings/audit", label: "Audit log", hint: "soon" },
    ],
  },
];

export function AppNav() {
  const pathname = usePathname();
  return (
    <nav className="flex h-full flex-col gap-6 text-sm">
      <div className="flex items-center gap-2 px-2 pt-1">
        <Link href="/inbox" className="font-semibold tracking-tight">
          mail-ai
        </Link>
      </div>
      {SECTIONS.map((section) => (
        <div key={section.label} className="flex flex-col gap-1">
          <div className="px-2 text-[11px] uppercase tracking-wider text-muted">
            {section.label}
          </div>
          {section.items.map((item) => (
            <NavLink key={item.href} item={item} active={isActive(pathname, item.href)} />
          ))}
        </div>
      ))}
      <div className="mt-auto px-2 pb-1 text-[11px] text-muted">
        v0.1 · dev
      </div>
    </nav>
  );
}

function NavLink({ item, active }: { item: NavItem; active: boolean }): ReactNode {
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={
        "flex items-center justify-between rounded-md px-2 py-1.5 transition-colors " +
        (active
          ? "bg-bg text-fg font-medium"
          : "text-muted hover:bg-bg hover:text-fg")
      }
    >
      <span>{item.label}</span>
      {item.hint ? (
        <span className="text-[10px] uppercase tracking-wider text-muted">
          {item.hint}
        </span>
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
