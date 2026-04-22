"use client";

// AppShell sits one level above pages. It owns the palette registry,
// the global Cmd+K (Mod+K) keybind, and renders the palette overlay.
// Everything mounted underneath can use useRegisterPaletteCommands()
// to contribute scoped actions, and any component can call
// usePaletteRegistry().open() to pop the palette without typing.

import { useRouter } from "next/navigation";
import { useEffect, useMemo, type ReactNode } from "react";
import { useTheme } from "next-themes";
import { useTranslator } from "../i18n/useTranslator";
import { useI18n } from "../i18n/I18nProvider";
import { CommandPalette } from "./CommandPalette";
import {
  PaletteRegistryProvider,
  usePaletteRegistry,
} from "./paletteRegistry";
import type { PaletteCommand } from "./types";

export function AppShell({ children }: { children: ReactNode }) {
  // Static commands are computed inside an inner component so the
  // memo identity is stable across renders of the page tree.
  return (
    <ShellWithStaticCommands>
      <KeybindLayer>{children}</KeybindLayer>
      <CommandPalette />
    </ShellWithStaticCommands>
  );
}

function ShellWithStaticCommands({ children }: { children: ReactNode }) {
  const router = useRouter();
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
        run: () => router.push("/inbox"),
      },
      {
        id: "go-search",
        label: t("commands.go-search.label"),
        hint: t("commands.go-search.description"),
        section: t("palette.groupNavigation"),
        shortcut: "g s",
        run: () => router.push("/search"),
      },
      {
        id: "go-calendar",
        label: t("commands.go-calendar.label"),
        hint: t("commands.go-calendar.description"),
        section: t("palette.groupNavigation"),
        shortcut: "g c",
        run: () => router.push("/calendar"),
      },
      {
        id: "go-accounts",
        label: t("commands.go-accounts.label"),
        hint: t("commands.go-accounts.description"),
        section: t("palette.groupNavigation"),
        run: () => router.push("/settings/account"),
      },
      {
        id: "go-inboxes",
        label: t("commands.go-inboxes.label"),
        hint: t("commands.go-inboxes.description"),
        section: t("palette.groupNavigation"),
        run: () => router.push("/settings/inboxes"),
      },
      {
        id: "go-audit",
        label: t("commands.go-audit.label"),
        hint: t("commands.go-audit.description"),
        section: t("palette.groupNavigation"),
        run: () => router.push("/settings/audit"),
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
    [t, router, setLocale, locale, theme, setTheme],
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
