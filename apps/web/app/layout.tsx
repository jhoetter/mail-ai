import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "mail-ai",
  description: "AI-native email collaboration",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
