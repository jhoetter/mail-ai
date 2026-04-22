// Public surface of @mailai/oauth-tokens.
//
// We intentionally only re-export:
//
//   - OAuth authorization helpers (`google.ts`, `microsoft.ts`,
//     `xoauth2.ts`) — needed by the connect flow + future IMAP path.
//   - The token refresher (`refresher.ts`, `types.ts`) — every other
//     package goes through `getValidAccessToken` to get an access
//     token, regardless of the underlying mail provider.
//   - The adapter classes (`adapters/index.js`) — concrete
//     implementations of the @mailai/providers ports. Server code
//     constructs these once at boot and registers them; everywhere
//     else uses the registry.
//
// What we deliberately do NOT re-export:
//
//   - `gmail.ts`, `graph.ts`, `send.ts`, `calendar.ts`, `contacts.ts`
//     — these are the provider-specific REST clients. They live
//     behind the MailProvider/CalendarProvider/ContactsProvider/
//     PushProvider ports in @mailai/providers; only the adapter layer
//     (packages/oauth-tokens/src/adapters/) imports them directly.
//
//   - `gmailLabelIdsToUserLabels` etc. live on the adapter exports
//     because they're tied to one provider's wire format and don't
//     belong in the public surface.
//
// scripts/check-architecture.mjs enforces the boundary so a server
// handler that tries to import gmail.ts directly fails CI.

export * from "./types.js";
export * from "./google.js";
export * from "./microsoft.js";
export * from "./refresher.js";
export * from "./xoauth2.js";
export * from "./userinfo.js";
export * from "./adapters/index.js";
