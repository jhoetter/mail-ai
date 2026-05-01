// Thin wrapper around <Shell sidebar={<AppNav />}> that also honours
// the AppShell `chrome` mode. In "content" mode (used when the host —
// e.g. hof-os — embeds mail-ai inside its own shell) we omit AppNav so
// our 240px rail does not double up with the host's left navigation.
//
// Pages should prefer <PageShell> over building <Shell sidebar={<AppNav />}>
// by hand; that way every page picks up the chrome-aware behaviour
// uniformly without needing to thread props through the page tree.
//
// Standalone behaviour (chrome="full", the default) is byte-identical to
// the previous direct usage.

import type { ReactNode } from "react";

import { useChrome } from "../lib/shell";
import { MailShell } from "./AppNav";

export function PageShell({ children }: { children: ReactNode }) {
  const chrome = useChrome();
  if (chrome === "content") return <>{children}</>;
  return <MailShell>{children}</MailShell>;
}
