// MailAiThread — headless thread pane. Mail-ai's thread reader is
// not a standalone route in the standalone shell: ThreadView is a
// child of the inbox page, opened via `?thread=<id>`. To preserve a
// single source of truth (so reply / starring / palette commands
// keep working without forking ThreadView), this pane mounts the
// same `InboxPage` and just defaults the MemoryRouter entry to a
// `?thread=` deep-link. Hosts that want a thread-only surface can
// pass `initialPath="/inbox?thread=<id>"`.

import InboxPage from "@/inbox/page";
import { ChromeProvider } from "@/lib/shell";

import { EmbeddedPane, type EmbeddedPaneProps } from "./EmbeddedPane.js";

export function MailAiThread({ initialPath, onNavigate }: EmbeddedPaneProps) {
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
