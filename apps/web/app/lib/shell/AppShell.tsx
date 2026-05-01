// AppShell sits one level above pages. It owns the palette registry,
// the global Cmd+K (Mod+K) keybind, and renders the palette overlay.
// Everything mounted underneath can use useRegisterPaletteCommands()
// to contribute scoped actions, and any component can call
// usePaletteRegistry().open() to pop the palette without typing.

import { useNavigate } from "react-router";
import { useEffect, useMemo, type ReactNode } from "react";
import { useTheme } from "next-themes";
import { useTranslator } from "../i18n/useTranslator";
import { useI18n } from "../i18n/I18nProvider";
import { CommandPalette } from "./CommandPalette";
import { PaletteRegistryProvider, usePaletteRegistry } from "./paletteRegistry";
import type { PaletteCommand } from "./types";
import { CommandErrorToast } from "../../components/CommandErrorToast";
import { ChromeProvider, useChrome } from "./ChromeContext";

const GLOBAL_APP_LINKS = [
  { id: "os", label: "App", href: "http://localhost:3000/" },
  { id: "hofos", label: "hofOS", href: "http://localhost:3000/__subapps/hofos/customers" },
  { id: "mailai", label: "Mail", href: "/inbox" },
  { id: "collabai", label: "Chat", href: "http://localhost:3000/__subapps/collabai/" },
  { id: "driveai", label: "Drive", href: "http://localhost:3000/__subapps/driveai/drive/home" },
  { id: "pagesai", label: "Pages", href: "http://localhost:3000/__subapps/pagesai/pages" },
] as const;

/**
 * Visual mode for the shell.
 *
 * - `"full"` (default) — renders the standalone sidebar identity and
 *   local app commands.
 * - `"content"` — drops the TopBar so a host can supply its own
 *   sidebar/header. Palette registry, ⌘K keybind, CommandPalette
 *   overlay and error-toast are preserved (they're functional
 *   behaviour, not visual chrome). Used by hof-os, which already
 *   owns the left nav and a host-level header.
 */
export type AppShellChrome = "full" | "content";

export function AppShell({
  children,
  chrome = "full",
}: {
  children: ReactNode;
  chrome?: AppShellChrome;
}) {
  // Static commands are computed inside an inner component so the
  // memo identity is stable across renders of the page tree.
  //
  // Layout: keep the standalone app in the same full-height shell shape
  // as the hofOS host. Shell (used by each page) fills this container.
  return (
    <ChromeProvider chrome={chrome}>
      <ShellWithStaticCommands>
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex min-h-0 flex-1 flex-col">
            <KeybindLayer>{children}</KeybindLayer>
          </div>
        </div>
        <CommandPalette />
        <CommandErrorToast />
      </ShellWithStaticCommands>
    </ChromeProvider>
  );
}

function ShellWithStaticCommands({ children }: { children: ReactNode }) {
  // useNavigate replaces Next's useRouter — same idea: imperatively
  // navigate to a path. Returned function identity is stable across
  // renders so listing it in the staticCommands deps is cheap.
  const navigate = useNavigate();
  const { t } = useTranslator();
  const { setLocale, locale } = useI18n();
  const { theme, setTheme } = useTheme();

  const staticCommands = useMemo<PaletteCommand[]>(
    () => [
      {
        id: "go-inbox",
        label: t("commands.go-inbox.label"),
        hint: t("commands.go-inbox.description"),
        section: t("palette.groupNavigation"),
        shortcut: "g i",
        run: () => navigate("/inbox"),
      },
      {
        id: "go-calendar",
        label: t("commands.go-calendar.label"),
        hint: t("commands.go-calendar.description"),
        section: t("palette.groupNavigation"),
        shortcut: "g c",
        run: () => navigate("/calendar"),
      },
      {
        id: "go-accounts",
        label: t("commands.go-accounts.label"),
        hint: t("commands.go-accounts.description"),
        section: t("palette.groupNavigation"),
        run: () => navigate("/settings/account"),
      },
      {
        id: "switch-language",
        label: t("commands.switch-language.label"),
        hint: t("commands.switch-language.description"),
        section: t("palette.groupActions"),
        run: () => setLocale(locale === "en" ? "de" : "en"),
      },
      {
        id: "switch-theme",
        label: t("commands.switch-theme.label"),
        hint: t("commands.switch-theme.description"),
        section: t("palette.groupActions"),
        run: () => {
          const order = ["light", "dark", "system"] as const;
          const current = (theme ?? "system") as (typeof order)[number];
          const next = order[(order.indexOf(current) + 1) % order.length]!;
          setTheme(next);
        },
      },
      ...GLOBAL_APP_LINKS.map((app) => ({
        id: `open-app-${app.id}`,
        label: `Open ${app.label}`,
        hint: "Switch app",
        section: "Apps",
        run: () => {
          window.location.href = app.href;
        },
      })),
    ],
    [t, navigate, setLocale, locale, theme, setTheme],
  );

  return (
    <PaletteRegistryProvider staticCommands={staticCommands}>{children}</PaletteRegistryProvider>
  );
}

function KeybindLayer({ children }: { children: ReactNode }) {
  const reg = usePaletteRegistry();
  const chrome = useChrome();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (chrome === "content") {
          e.stopPropagation();
          e.stopImmediatePropagation();
        }
        reg.toggle();
      }
    };
    window.addEventListener("keydown", onKey, { capture: chrome === "content" });
    return () => window.removeEventListener("keydown", onKey, { capture: chrome === "content" });
  }, [reg, chrome]);

  return <>{children}</>;
}
