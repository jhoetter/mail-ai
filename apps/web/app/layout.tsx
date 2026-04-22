import type { ReactNode } from "react";
import "./globals.css";
import { I18nProvider } from "./lib/i18n";

export const metadata = {
  title: "mail-ai",
  description: "AI-native email collaboration",
};

// The `lang` attribute starts at "en" and is updated client-side once
// the I18nProvider settles on the cookie / navigator preference. We
// avoid threading the cookie through the RSC boundary because the
// app is a single client SPA — extra round-tripping would buy us
// nothing for ~1 frame of locale lag.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
