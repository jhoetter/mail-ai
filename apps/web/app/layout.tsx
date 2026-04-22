import type { ReactNode } from "react";
import "./globals.css";
import { I18nProvider } from "./lib/i18n";
import { AppShell } from "./lib/shell";
import { ThemeProvider } from "./lib/theme-provider";

export const metadata = {
  title: "mail-ai",
  description: "AI-native email collaboration",
};

// The `lang` attribute starts at "en" and is updated client-side once
// the I18nProvider settles on the cookie / navigator preference. We
// avoid threading the cookie through the RSC boundary because the
// app is a single client SPA — extra round-tripping would buy us
// nothing for ~1 frame of locale lag.
//
// `suppressHydrationWarning` is required by next-themes: the
// ThemeProvider injects the resolved theme class on <html> before
// React hydrates, which would otherwise trip the mismatch warning.
//
// Fonts (Inter + IBM Plex Mono) are loaded with a plain <link> tag so
// Turbopack doesn't try to resolve them at compile time (a CSS
// `@import url(https://...)` in globals.css makes the dev server hang
// when fonts.googleapis.com is slow/blocked). The system fallbacks
// declared on --font-sans / --font-mono cover the brief flash before
// the network sheet lands.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap"
        />
      </head>
      <body className="h-full bg-background text-foreground antialiased">
        <ThemeProvider>
          <I18nProvider>
            <AppShell>{children}</AppShell>
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
