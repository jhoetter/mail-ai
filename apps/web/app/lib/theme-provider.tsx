import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ReactNode } from "react";

/**
 * Theme provider — wraps next-themes so the rest of the app can pick a
 * theme via a single hook (`useTheme()` from "next-themes"). Three modes
 * are supported out of the box:
 *
 *   • "light"  — forces the light brand palette (`html.light`)
 *   • "dark"   — forces the dark brand palette (`html.dark`)
 *   • "system" — defers to the OS via prefers-color-scheme
 *
 * The class is set on <html> so the CSS variable overrides in
 * @mailai/design-tokens/styles.css (`.dark, html.dark`) latch on, and
 * the `prefers-color-scheme` fallback in styles.css uses
 * `:root:not(.light)` so an explicit light selection wins over the OS.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
