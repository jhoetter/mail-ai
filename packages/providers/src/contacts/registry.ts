// ContactsProviderRegistry: same shape as MailProviderRegistry /
// CalendarProviderRegistry. Adapters self-identify via `id` and the
// registry is keyed off MailProviderId so the same provider string
// the OAuth row already carries selects the contacts adapter too.

import type { MailProviderId } from "../types.js";
import type { ContactsProvider } from "./port.js";

export class ContactsProviderRegistry {
  private readonly map = new Map<MailProviderId, ContactsProvider>();

  register(adapter: ContactsProvider): void {
    if (this.map.has(adapter.id)) {
      throw new Error(`contacts adapter already registered for ${adapter.id}`);
    }
    this.map.set(adapter.id, adapter);
  }

  for(id: MailProviderId): ContactsProvider | null {
    return this.map.get(id) ?? null;
  }

  has(id: MailProviderId): boolean {
    return this.map.has(id);
  }

  list(): ReadonlyArray<ContactsProvider> {
    return Array.from(this.map.values());
  }
}
