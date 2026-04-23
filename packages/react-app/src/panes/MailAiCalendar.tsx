// MailAiCalendar — headless calendar pane. Mirrors the standalone
// calendar page so the host can mount it as a sibling to the inbox
// inside its own chrome.

import CalendarPage from "@/calendar/page";
import { ChromeProvider } from "@/lib/shell";

import { EmbeddedPane, type EmbeddedPaneProps } from "./EmbeddedPane.js";

export function MailAiCalendar({ initialPath, onNavigate }: EmbeddedPaneProps) {
  return (
    <ChromeProvider chrome="content">
      <EmbeddedPane
        defaultPath="/calendar"
        {...(initialPath !== undefined ? { initialPath } : {})}
        {...(onNavigate !== undefined ? { onNavigate } : {})}
      >
        <CalendarPage />
      </EmbeddedPane>
    </ChromeProvider>
  );
}
