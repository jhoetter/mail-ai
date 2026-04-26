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
import { ChromeProvider, useChrome } from "./ChromeContext";

/**
 * Visual mode for the shell.
 *
 * - `"full"` (default) — renders the standalone chrome (TopBar with
 *   global search). Used by the standalone `apps/web` and any host
 *   that wants the full mail-ai UI.
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
  // Layout: the TopBar (global search) is the first row in "full"
  // mode; in "content" mode it's omitted and the page tree fills
  // the host's container directly. Shell (used by each page) was
  // switched from h-screen to h-full so it fills *this* container
  // instead of overflowing past the search bar.
  return (
    <ChromeProvider chrome={chrome}>
      <ShellWithStaticCommands>
        <div className="flex h-full min-h-0 flex-col">
          {chrome === "full" ? <TopBar /> : null}
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
