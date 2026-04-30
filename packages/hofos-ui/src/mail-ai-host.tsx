import { lazy, Suspense } from "react";
import { MemoryRouter, Navigate, Route, Routes } from "react-router";
import "../../../apps/web/app/globals.css";
import { DialogsProvider } from "@mailai/ui";
import { I18nProvider } from "../../../apps/web/app/lib/i18n";
import { RealtimeProvider } from "../../../apps/web/app/lib/realtime";
import {
  RuntimeConfigProvider,
  type RuntimeConfig,
} from "../../../apps/web/app/lib/runtime-config";
import { AppShell } from "../../../apps/web/app/lib/shell";
import { HostChromeProvider } from "../../../apps/web/app/lib/shell/hostChrome";
import { ThemeProvider } from "../../../apps/web/app/lib/theme-provider";

export type MailInitialRoute = "/inbox" | "/calendar" | "/settings/account";

export interface MailAiHostProps {
  runtime: RuntimeConfig;
  initialRoute?: MailInitialRoute;
}

export interface MailAiRouteDefinition {
  path: string;
  initialRoute: MailInitialRoute;
}

export const product = "mailai" as const;

export const mailAiRoutes: MailAiRouteDefinition[] = [
  { path: "/mail", initialRoute: "/inbox" },
  { path: "/mail/inbox", initialRoute: "/inbox" },
  { path: "/mail/inbox/thread/:threadId", initialRoute: "/inbox" },
  { path: "/mail/settings/account", initialRoute: "/settings/account" },
  { path: "/calendar", initialRoute: "/calendar" },
];

const InboxPage = lazy(() => import("../../../apps/web/app/inbox/page"));
const CalendarPage = lazy(() => import("../../../apps/web/app/calendar/page"));
const SettingsAccountPage = lazy(() => import("../../../apps/web/app/settings/account/page"));

export function MailAiHost({ runtime, initialRoute = "/inbox" }: MailAiHostProps) {
  return (
    <RuntimeConfigProvider runtime={runtime}>
      <ThemeProvider>
        <I18nProvider>
          <DialogsProvider>
            <RealtimeProvider>
              <HostChromeProvider>
                <MemoryRouter initialEntries={[initialRoute]}>
                  <AppShell chrome="content">
                    <Suspense fallback={<MailAiLoader />}>
                      <Routes>
                        <Route path="/" element={<Navigate to="/inbox" replace />} />
                        <Route path="/inbox" element={<InboxPage />} />
                        <Route path="/calendar" element={<CalendarPage />} />
                        <Route path="/settings/account" element={<SettingsAccountPage />} />
                        <Route path="*" element={<Navigate to="/inbox" replace />} />
                      </Routes>
                    </Suspense>
                  </AppShell>
                </MemoryRouter>
              </HostChromeProvider>
            </RealtimeProvider>
          </DialogsProvider>
        </I18nProvider>
      </ThemeProvider>
    </RuntimeConfigProvider>
  );
}

function MailAiLoader() {
  return (
    <div className="flex h-full min-h-0 w-full items-center justify-center text-sm text-secondary">
      Loading mail...
    </div>
  );
}
