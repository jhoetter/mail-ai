// MailAiInbox — headless inbox pane. Re-uses the canonical
// `apps/web/app/inbox/page.tsx` content but wraps it in its own
// MemoryRouter + ChromeProvider so the host's BrowserRouter is not
// touched by inner navigation and the embedded `PageShell` skips
// rendering its own left rail (the host already supplies one via
// `MailAiViewNav` + `MailAiSettingsNav`).
//
// Phase A contract:
//   - `initialPath` seeds the MemoryRouter (e.g. `/inbox?view=foo`
//     or `/inbox?thread=bar`). Defaults to `/inbox`.
//   - `onNavigate(path)` fires whenever the inner location changes,
//     so the host can mirror it into its own URL.

import InboxPage from "@/inbox/page";
import { ChromeProvider } from "@/lib/shell";

import { EmbeddedPane, type EmbeddedPaneProps } from "./EmbeddedPane.js";

export function MailAiInbox({ initialPath, onNavigate }: EmbeddedPaneProps) {
  return (
    <ChromeProvider chrome="content">
      <EmbeddedPane
        defaultPath="/inbox"
        {...(initialPath !== undefined ? { initialPath } : {})}
        {...(onNavigate !== undefined ? { onNavigate } : {})}
      >
        <InboxPage />
      </EmbeddedPane>
    </ChromeProvider>
  );
}
