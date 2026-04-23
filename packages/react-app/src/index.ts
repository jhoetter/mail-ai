// Public re-exports. Hosts can `import { MailAiApp } from "@mailai/react-app"`
// for the legacy v0.1 monolith embed, or use the more granular subpath
// imports / the v0.2 headless composables for tree-shaken control.
//
// Phase A (v0.2) headless composables let the host (hof-os) build its
// own chrome and slot mail-ai pieces into it:
//
//   import {
//     MailAiProvider,
//     MailAiViewNav,
//     MailAiSettingsNav,
//     MailAiSearchInput,
//     MailAiInbox,
//     MailAiThread,
//     MailAiCompose,
//     MailAiCalendar,
//     mailaiCommands,
//   } from "@mailai/react-app";

export * from "./contract.js";

// Legacy monolith — kept for BC; standalone-only going forward.
export { MailAiApp } from "./MailAiApp.js";
export type { MailAiAppProps, MailAiSurface } from "./MailAiApp.js";

// Provider — exported under both names. `AppProviders` stays around
// for `apps/web/src/main.tsx`; new embeds use `MailAiProvider`.
export { AppProviders } from "./AppProviders.js";
export type { AppProvidersProps } from "./AppProviders.js";
export { MailAiProvider } from "./MailAiProvider.js";
export type { MailAiProviderProps } from "./MailAiProvider.js";

// Direct content-component re-exports (pre-Phase-A; kept for
// callers who already import them by name).
export { Inbox } from "./components/inbox.js";
export { ThreadView } from "./components/thread.js";
export { Composer } from "./components/compose.js";
export { LoadingBlank, EmptyInboxBlank } from "./blanks.js";
export { AttachmentViewer, attachmentKindFor } from "./components/AttachmentViewer.js";
export type { AttachmentKind, AttachmentViewerProps } from "./components/AttachmentViewer.js";

// Phase A — headless navigation primitives.
export { MailAiViewNav } from "./nav/MailAiViewNav.js";
export type { MailAiViewNavProps } from "./nav/MailAiViewNav.js";
export { MailAiSettingsNav } from "./nav/MailAiSettingsNav.js";
export type { MailAiSettingsNavProps } from "./nav/MailAiSettingsNav.js";

// Phase A — headless content panes.
export { MailAiInbox } from "./panes/MailAiInbox.js";
export { MailAiThread } from "./panes/MailAiThread.js";
export { MailAiCompose } from "./panes/MailAiCompose.js";
export { MailAiCalendar } from "./panes/MailAiCalendar.js";
export type { EmbeddedPaneProps } from "./panes/EmbeddedPane.js";

// Phase A — host-driven palette + search.
export { mailaiCommands } from "./commands/mailaiCommands.js";
export type { MailAiCommandContext } from "./commands/mailaiCommands.js";
export { MailAiSearchInput } from "./MailAiSearchInput.js";
export type { MailAiSearchInputProps } from "./MailAiSearchInput.js";
