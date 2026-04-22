// Normalized contact-shaped types. Mirrors what `oauth-tokens/contacts.ts`
// already returns so callers (the suggest route, the contacts sync
// handler) can hold a `ContactsProvider` reference without pulling
// adapter code into the server.
//
// `source` distinguishes the three shelves an address book can sit
// on:
//   - "my"     → explicit user-maintained address book entries
//   - "other"  → provider-collected senders/recipients (Google's
//                otherContacts; no Graph equivalent today, so an
//                Outlook adapter simply returns [] for this source)
//   - "people" → ranked frequent collaborators (Graph /me/people;
//                Google has no public equivalent today, so a Google
//                adapter returns [] for this source)
//
// Keeping the same enum across providers lets the suggest route
// rank by source uniformly (`my` > `people` > `other`) without
// branching on the upstream API.

export type ContactSource = "my" | "other" | "people";

export interface NormalizedContactEmail {
  readonly address: string;
  readonly type?: string;
  readonly primary?: boolean;
}

export interface NormalizedContact {
  readonly providerContactId: string;
  readonly source: ContactSource;
  readonly displayName: string | null;
  readonly emails: readonly NormalizedContactEmail[];
  // When the upstream API tells us when the contact was last
  // touched. Used to break ranking ties + bias suggest results
  // toward people the user has actually interacted with recently.
  readonly lastInteractionAt?: Date;
}
