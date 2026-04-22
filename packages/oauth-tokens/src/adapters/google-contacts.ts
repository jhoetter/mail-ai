// GoogleContactsAdapter — wraps the People API helpers in
// `../contacts.js` so the server only ever talks to the
// ContactsProvider port. Google supports both "my" (people.connections)
// and "other" (otherContacts) but has no public "people" surface, so
// `listFrequent` returns []. Capabilities advertise this so the
// suggest route can grey out "frequent" entries when no adapter
// exposes them.

import type {
  AccessTokenArgs,
  ContactsProvider,
  ContactsProviderCapabilities,
} from "@mailai/providers";
import type { NormalizedContact } from "@mailai/providers/contacts";
import {
  listGoogleConnections,
  listGoogleOtherContacts,
} from "../contacts.js";

const CAPABILITIES: ContactsProviderCapabilities = {
  ownContacts: true,
  otherContacts: true,
  // Google has no public "ranked frequent collaborators" endpoint
  // analogous to Graph's /me/people. Mark unsupported so the suggest
  // route never tries the surface.
  frequentPeople: false,
};

export class GoogleContactsAdapter implements ContactsProvider {
  readonly id = "google-mail" as const;
  readonly capabilities: ContactsProviderCapabilities = CAPABILITIES;

  async listOwnContacts(
    args: AccessTokenArgs,
  ): Promise<ReadonlyArray<NormalizedContact>> {
    return listGoogleConnections({ accessToken: args.accessToken });
  }

  async listOtherContacts(
    args: AccessTokenArgs,
  ): Promise<ReadonlyArray<NormalizedContact>> {
    return listGoogleOtherContacts({ accessToken: args.accessToken });
  }

  async listFrequent(
    _args: AccessTokenArgs,
  ): Promise<ReadonlyArray<NormalizedContact>> {
    return [];
  }
}
