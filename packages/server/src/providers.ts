// Single place where the server wires concrete adapters into the
// MailProviderRegistry. Handlers and routes import the registry
// (or take it as a dep) and never reach for the concrete adapter
// classes. Adding a third provider becomes one `register()` call
// here plus a new MailProviderId variant in @mailai/providers.

import {
  CalendarProviderRegistry,
  ContactsProviderRegistry,
  MailProviderRegistry,
  PushProviderRegistry,
} from "@mailai/providers";
import {
  GoogleCalendarAdapter,
  GoogleContactsAdapter,
  GoogleMailAdapter,
  GoogleMailPushAdapter,
  OutlookCalendarAdapter,
  OutlookContactsAdapter,
  OutlookMailAdapter,
  OutlookMailPushAdapter,
} from "@mailai/oauth-tokens";

export function buildMailProviderRegistry(): MailProviderRegistry {
  const registry = new MailProviderRegistry();
  registry.register(new GoogleMailAdapter());
  registry.register(new OutlookMailAdapter());
  return registry;
}

// Push-provider counterpart. Handlers don't touch this directly —
// the SyncScheduler owns the subscribe/renew loop.
export function buildPushProviderRegistry(): PushProviderRegistry {
  const registry = new PushProviderRegistry();
  registry.register(new GoogleMailPushAdapter());
  registry.register(new OutlookMailPushAdapter());
  return registry;
}

// Calendar-provider counterpart. Calendar handlers take this through
// CalendarHandlerDeps and never construct adapters directly.
export function buildCalendarProviderRegistry(): CalendarProviderRegistry {
  const registry = new CalendarProviderRegistry();
  registry.register(new GoogleCalendarAdapter());
  registry.register(new OutlookCalendarAdapter());
  return registry;
}

// Contacts-provider counterpart. The suggest route + the contacts
// sync handler take this through their deps; nothing under
// `routes/` or `handlers/` constructs an adapter directly.
export function buildContactsProviderRegistry(): ContactsProviderRegistry {
  const registry = new ContactsProviderRegistry();
  registry.register(new GoogleContactsAdapter());
  registry.register(new OutlookContactsAdapter());
  return registry;
}
