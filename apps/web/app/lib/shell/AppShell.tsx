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
import { TopBar } from "../../components/TopBar";

export function AppShell({ children }: { children: ReactNode }) {
  // Static commands are computed inside an inner component so the
  // memo identity is stable across renders of the page tree.
  //
  // Layout: the TopBar (global search) is the first row, every page
  // tree mounts inside the flex-1 region below it. Shell (used by
  // each page) was switched from h-screen to h-full so it fills
  // *this* container instead of overflowing past the search bar.
  return (
    <ShellWithStaticCommands>
      <div className="flex h-screen min-h-0 flex-col">
        <TopBar />
        <div className="flex min-h-0 flex-1 flex-col">
          <KeybindLayer>{children}</KeybindLayer>
        </div>
      </div>
      <CommandPalette />
      <CommandErrorToast />
    </ShellWithStaticCommands>
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
        id: "go-inboxes",
        label: t("commands.go-inboxes.label"),
        hint: t("commands.go-inboxes.description"),
        section: t("palette.groupNavigation"),
        run: () => navigate("/settings/inboxes"),
      },
      {
        id: "go-audit",
        label: t("commands.go-audit.label"),
        hint: t("commands.go-audit.description"),
        section: t("palette.groupNavigation"),
        run: () => navigate("/settings/audit"),
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
    ],
    [t, navigate, setLocale, locale, theme, setTheme],
  );

  return (
    <PaletteRegistryProvider staticCommands={staticCommands}>{children}</PaletteRegistryProvider>
  );
}

function KeybindLayer({ children }: { children: ReactNode }) {
  const reg = usePaletteRegistry();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Mod+K (Cmd on macOS, Ctrl elsewhere). We deliberately also
      // accept Ctrl+K everywhere so users on Linux/Windows hitting
      // Ctrl don't have to relearn anything.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        reg.toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reg]);

  return <>{children}</>;
}
