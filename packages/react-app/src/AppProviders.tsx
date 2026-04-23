// AppProviders: the single React provider stack that the standalone
// `apps/web/src/main.tsx` and the embedded `MailAiApp` mount on top.
//
// The standalone shell renders this with no `runtime` prop so the lib
// modules fall back to their historic defaults (origin-relative `/api`,
// `:1235` ws). The embed root passes a `RuntimeConfig` derived from
// `MailaiHostHooks` so URLs route through the host's proxy and a JWT
// is attached to every request.
//
// Keeping the provider order identical between the two surfaces
// guarantees that any component that compiles in `apps/web` also works
// inside the embed without surprise context misses (e.g. Inbox calling
// `useTranslator()` would crash if I18nProvider were skipped).

import { type ReactNode } from "react";
import { DialogsProvider } from "@mailai/ui";

import { I18nProvider } from "@/lib/i18n";
import { RealtimeProvider } from "@/lib/realtime";
import { ThemeProvider } from "@/lib/theme-provider";
import { RuntimeConfigProvider, type RuntimeConfig } from "@/lib/runtime-config";

export interface AppProvidersProps {
  /**
   * Optional embed-supplied runtime. `null` / omitted = standalone
   * defaults (env-based base URL, no auth header, port-1235 realtime).
   */
  readonly runtime?: RuntimeConfig | null;
  readonly children: ReactNode;
}

export function AppProviders({ runtime = null, children }: AppProvidersProps) {
  return (
    <RuntimeConfigProvider runtime={runtime}>
      <ThemeProvider>
        <I18nProvider>
          <DialogsProvider>
            <RealtimeProvider>{children}</RealtimeProvider>
          </DialogsProvider>
        </I18nProvider>
      </ThemeProvider>
    </RuntimeConfigProvider>
  );
}
