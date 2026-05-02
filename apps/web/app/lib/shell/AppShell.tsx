// AppShell sits one level above pages. It owns the palette registry,
// the global Cmd+K (Mod+K) keybind, and renders the palette overlay.
// Everything mounted underneath can use useRegisterPaletteCommands()
// to contribute scoped actions, and any component can call
// usePaletteRegistry().open() to pop the palette without typing.

import { useNavigate } from "react-router";
import { useMemo, type ReactNode } from "react";
import { useTheme } from "next-themes";
import { HOF_SHELL_APP_LINKS } from "@hofos/shell-ui";
import { createAppLinkCommands, useRegisteredSearchShortcut, useShortcut } from "@hofos/ux";
import { useTranslator } from "../i18n/useTranslator";
import { useI18n } from "../i18n/I18nProvider";
import { CommandPalette } from "./CommandPalette";
import { PaletteRegistryProvider, usePaletteRegistry } from "./paletteRegistry";
import type { PaletteCommand } from "./types";
import { CommandErrorToast } from "../../components/CommandErrorToast";
import { ChromeProvider, useChrome } from "./ChromeContext";

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
      ...createAppLinkCommands(
        HOF_SHELL_APP_LINKS.map((link) =>
          link.id === "mailai" ? { ...link, href: "/inbox" } : link,
        ),
      ).map((cmd) => ({
        id: cmd.id,
        label: String(cmd.label),
        hint: "Switch app",
        section: cmd.group,
        run: () => {
          void cmd.perform?.();
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

  useShortcut(
    useMemo(
      () => [
        {
          key: "k",
          meta: true,
          capture: chrome === "content",
          stopPropagation: chrome === "content",
          stopImmediatePropagation: chrome === "content",
          description: "Open command palette",
          run: reg.toggle,
        },
      ],
      [chrome, reg.toggle],
    ),
  );
  useRegisteredSearchShortcut();

  return <>{children}</>;
}
