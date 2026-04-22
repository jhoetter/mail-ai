import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
} from "react-router";

// Global stylesheet — Tailwind, design tokens, prose-mailai. Keeping
// the import here (rather than referencing it from index.html) lets
// Vite's HMR push CSS updates without a full reload.
import "../app/globals.css";

import { I18nProvider } from "../app/lib/i18n";
import { AppShell } from "../app/lib/shell";
import { ThemeProvider } from "../app/lib/theme-provider";

import InboxPage from "../app/inbox/page";
import CalendarPage from "../app/calendar/page";
import DraftsPage from "../app/drafts/page";
import SearchPage from "../app/search/page";
import SettingsAccountPage from "../app/settings/account/page";
import SettingsInboxesPage from "../app/settings/inboxes/page";
import SettingsAuditPage from "../app/settings/audit/page";
import SettingsTagsPage from "../app/settings/tags/page";

// React Router replaces Next's file-based router. The route table is
// intentionally flat: every page mounts its own <Shell> with the
// AppNav already wired in (same pattern the Next pages used), so
// there's no shared layout component to thread state through. The
// outer providers (theme + i18n + AppShell command palette) wrap the
// entire router so they survive route changes.
function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/inbox" replace />} />
      <Route path="/inbox" element={<InboxPage />} />
      <Route path="/calendar" element={<CalendarPage />} />
      <Route path="/drafts" element={<DraftsPage />} />
      <Route path="/search" element={<SearchPage />} />
      <Route path="/settings/account" element={<SettingsAccountPage />} />
      <Route path="/settings/inboxes" element={<SettingsInboxesPage />} />
      <Route path="/settings/audit" element={<SettingsAuditPage />} />
      <Route path="/settings/tags" element={<SettingsTagsPage />} />
      <Route path="*" element={<Navigate to="/inbox" replace />} />
    </Routes>
  );
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found in index.html");

createRoot(rootEl).render(
  <StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <BrowserRouter>
          <AppShell>
            <AppRoutes />
          </AppShell>
        </BrowserRouter>
      </I18nProvider>
    </ThemeProvider>
  </StrictMode>,
);
