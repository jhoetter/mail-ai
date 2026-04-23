// @mailai/providers — provider-neutral ports and types for mail,
// calendar, contacts, and push notifications.
//
// Adapter implementations live in @mailai/oauth-tokens (Google,
// Microsoft) and any future transport package; they import this
// package to satisfy the contract. The server registers concrete
// adapters at boot and routes everything through the registry so
// the application code never touches a provider directly.

export * from "./types.js";
export * from "./mail/index.js";
export * from "./push/index.js";
// Calendar exports its own NormalizedAttendee/NormalizedEvent
// shapes that overlap by name with neither mail nor push, but it
// does collide with the calendar.ts re-exports from
// @mailai/oauth-tokens once handlers import from both. Calendar
// types are re-exported under an explicit submodule to keep the
// barrel shape predictable.
export * as calendar from "./calendar/index.js";
export { CalendarProviderRegistry } from "./calendar/registry.js";
export type { CalendarProvider, CalendarProviderCapabilities } from "./calendar/port.js";
// Contacts mirrors calendar's submodule barrel: shared names like
// `NormalizedContact` would otherwise clash with the legacy re-exports
// from @mailai/oauth-tokens during the migration.
export * as contacts from "./contacts/index.js";
export { ContactsProviderRegistry } from "./contacts/registry.js";
export type { ContactsProvider, ContactsProviderCapabilities } from "./contacts/port.js";
