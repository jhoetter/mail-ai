// ChromeContext exposes the active AppShell chrome mode to descendant
// pages so they can hide their own per-page navigation rail when the
// host (e.g. hof-os) already supplies one.
//
// AppShell's `chrome` prop only controls the global TopBar inside the
// shell itself. Pages wrap their content in `<Shell sidebar={<AppNav />}>`,
// which lives below AppShell and is invisible to it. Without a way for
// pages to discover the chrome mode, embedded mounts double up: hof-os
// renders its own left rail AND mail-ai renders <AppNav/> inside every
// page → two competing 240px columns and the symptom the user reported.
//
// The context default is "full" so any page rendered outside an
// <AppShell> (e.g. tests, storybook) keeps the standalone behaviour.
//
// IMPORTANT: this is a *visual* concern only. Do not gate functional
// behaviour (palette commands, keybinds, error-toast) on chrome — those
// stay active in both modes so hosts get the same in-app affordances.

import { createContext, useContext, type ReactNode } from "react";

import type { AppShellChrome } from "./AppShell";

const ChromeContext = createContext<AppShellChrome>("full");

export function ChromeProvider({
  chrome,
  children,
}: {
  chrome: AppShellChrome;
  children: ReactNode;
}) {
  return <ChromeContext.Provider value={chrome}>{children}</ChromeContext.Provider>;
}

export function useChrome(): AppShellChrome {
  return useContext(ChromeContext);
}
