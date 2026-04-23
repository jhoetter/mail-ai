// MailAiCompose — headless drafts pane. Mounts the standalone
// `DraftsPage`, which already exposes the Composer dialog inline.
// Hosts that want to open the Composer immediately can deep-link
// via `initialPath` (the standalone Composer is keyed off draft
// state, not the URL, so a host-driven route param is the cleanest
// seam — see future Phase B for a true `/compose/new` route).

import DraftsPage from "@/drafts/page";
import { ChromeProvider } from "@/lib/shell";

import { EmbeddedPane, type EmbeddedPaneProps } from "./EmbeddedPane.js";

export function MailAiCompose({ initialPath, onNavigate }: EmbeddedPaneProps) {
  return (
    <ChromeProvider chrome="content">
      <EmbeddedPane
        defaultPath="/drafts"
        {...(initialPath !== undefined ? { initialPath } : {})}
        {...(onNavigate !== undefined ? { onNavigate } : {})}
      >
        <DraftsPage />
      </EmbeddedPane>
    </ChromeProvider>
  );
}
