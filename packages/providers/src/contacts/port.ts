// ContactsProvider port. Same hexagonal split as the mail and
// calendar ports: the server holds a registry, every read goes
// through `for(provider)` + a method call, and adding a third
// provider is a new adapter file plus a register() line.

import type { MailProviderId } from "../types.js";
import type { AccessTokenArgs } from "../mail/port.js";
import type { NormalizedContact } from "./types.js";

export interface ContactsProviderCapabilities {
  // True if the adapter can return user-maintained address book
  // entries (`source: "my"`). Both Google and Outlook can today.
  readonly ownContacts: boolean;
  // True if the adapter can return provider-collected senders/recipients
  // (`source: "other"`). Google's People API exposes this via
  // `otherContacts`; Graph has no public equivalent today.
  readonly otherContacts: boolean;
  // True if the adapter can return ranked frequent collaborators
  // (`source: "people"`). Graph exposes this via `/me/people`;
  // Google has no public equivalent today.
  readonly frequentPeople: boolean;
}

// Re-export for symmetry with mail/port.
export type { AccessTokenArgs };

export interface ContactsProvider {
  readonly id: MailProviderId;
  readonly capabilities: ContactsProviderCapabilities;

  // Returns the user-maintained address book. Adapters that don't
  // support this surface return [] instead of throwing so callers
  // can treat all sources uniformly.
  listOwnContacts(args: AccessTokenArgs): Promise<ReadonlyArray<NormalizedContact>>;

  // Returns provider-collected senders/recipients. Same `[] when
  // unsupported` contract as listOwnContacts.
  listOtherContacts(args: AccessTokenArgs): Promise<ReadonlyArray<NormalizedContact>>;

  // Returns ranked frequent collaborators. Same `[] when
  // unsupported` contract as the others.
  listFrequent(args: AccessTokenArgs): Promise<ReadonlyArray<NormalizedContact>>;
}
