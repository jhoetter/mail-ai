// Public re-exports. Hosts can `import { MailAiApp } from "@mailai/react-app"`
// for the full embed, or use the more granular subpath imports for
// tree-shaking individual components.
export * from "./contract.js";
export { MailAiApp } from "./MailAiApp.js";
export type { MailAiAppProps, MailAiSurface } from "./MailAiApp.js";
export { AppProviders } from "./AppProviders.js";
export type { AppProvidersProps } from "./AppProviders.js";
export { Inbox } from "./components/inbox.js";
export { ThreadView } from "./components/thread.js";
export { Composer } from "./components/compose.js";
export { LoadingBlank, EmptyInboxBlank } from "./blanks.js";
export { AttachmentViewer, attachmentKindFor } from "./components/AttachmentViewer.js";
export type { AttachmentKind, AttachmentViewerProps } from "./components/AttachmentViewer.js";
