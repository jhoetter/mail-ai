// Public re-exports. Hosts can `import { Inbox } from "@mailai/react-app"`
// or use the more granular subpath imports for tree-shaking.
export * from "./contract.js";
export { MailAiApp, useMailAiHost } from "./MailAiApp.js";
export { Inbox } from "./components/inbox.js";
export { ThreadView } from "./components/thread.js";
export { Composer } from "./components/compose.js";
export { LoadingBlank, EmptyInboxBlank } from "./blanks.js";
