import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import {
  HofShellLayout,
  fetchHofShellUser,
  signOutOfHofShell,
  type HofShellUser,
  type HofShellNavGroup,
} from "@hofos/shell-ui";
import { useTranslator } from "../lib/i18n/useTranslator";
import { createHandoffAppLinks, navigateHandoffHref } from "../lib/shell/hofShellNavigation";
import { usePaletteRegistry } from "../lib/shell/paletteRegistry";
import { listViews, type ViewSummary } from "../lib/views-client";

const VIEW_ICONS: Record<string, string> = {
  Inbox: "inbox",
  Drafts: "file-text",
  Sent: "send",
  Snoozed: "moon",
  Done: "check-circle-2",
  Trash: "trash-2",
  Spam: "ban",
  "All Mail": "archive",
};

export function MailShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t } = useTranslator();
  const palette = usePaletteRegistry();
  const [views, setViews] = useState<ViewSummary[]>([]);
  const [shellUser, setShellUser] = useState<HofShellUser | null>(null);

  useEffect(() => {
    let alive = true;
    void listViews()
      .then((rows) => {
        if (alive) setViews(rows);
      })
      .catch(() => {
        if (alive) setViews([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void fetchHofShellUser({ endpoint: "/api/whoami", fallbackName: "Mail" }).then((user) => {
      if (alive) setShellUser(user);
    });
    return () => {
      alive = false;
    };
  }, []);

  const activeViewId = searchParams.get("view");
  const sortedViews = useMemo(
    () => [...views].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)),
    [views],
  );

  const primaryNavGroups = useMemo<HofShellNavGroup[]>(
    () => [
      {
        id: "email",
        label: t("nav.email"),
        items: sortedViews.map((view, index) => ({
          id: view.id,
          label: view.name,
          path: `/inbox?view=${encodeURIComponent(view.id)}`,
          icon: VIEW_ICONS[view.name] || "inbox",
          active: pathname === "/inbox" && (activeViewId === view.id || (!activeViewId && index === 0)),
        })),
      },
      {
        id: "calendar",
        label: t("nav.calendar"),
        items: [{ id: "calendar", label: t("nav.calendar"), path: "/calendar", icon: "calendar" }],
      },
      {
        id: "settings",
        label: t("nav.settings"),
        items: [
          { id: "accounts", label: t("nav.accounts"), path: "/settings/account", icon: "user" },
          { id: "mail-rules", label: t("nav.mailRules"), path: "/settings/mail-rules", icon: "filter" },
          { id: "vacation", label: t("nav.vacation"), path: "/settings/vacation", icon: "moon" },
        ],
      },
    ],
    [activeViewId, pathname, sortedViews, t],
  );

  return (
    <HofShellLayout
      appId="mailai"
      appLabel="Mail"
      appIcon="mail"
      currentPath={`${pathname}${window.location.search}`}
      primaryNavGroups={primaryNavGroups}
      appLinks={createHandoffAppLinks({ selfAppId: "mailai", selfHref: "/inbox" })}
      user={shellUser}
      onSignOut={() => signOutOfHofShell()}
      onCommand={() => palette.open()}
      onNavigate={(path) => {
        if (path.startsWith("/") && !path.startsWith("/__subapps/")) navigate(path);
        else navigateHandoffHref(path);
      }}
    >
      {children}
    </HofShellLayout>
  );
}

export function AppNav() {
  return null;
}
