// OutlookContactsAdapter — wraps the Graph helpers in
// `../contacts.js`. Graph exposes both `/me/contacts` ("my") and
// `/me/people` ("frequent"); it has no analogue for Google's
// `otherContacts`, so listOtherContacts returns []. Capabilities
// advertise the asymmetry so the suggest route can ignore unsupported
// sources without a try/catch.

import type {
  AccessTokenArgs,
  ContactsProvider,
  ContactsProviderCapabilities,
} from "@mailai/providers";
import type { NormalizedContact } from "@mailai/providers/contacts";
import {
  listGraphContacts,
  listGraphPeople,
} from "../contacts.js";

const CAPABILITIES: ContactsProviderCapabilities = {
  ownContacts: true,
  // No Graph endpoint that mirrors Google's `otherContacts` (the
  // auto-collected sender/recipient list). Adapter returns [] and
  // capability is false.
  otherContacts: false,
  frequentPeople: true,
};

export class OutlookContactsAdapter implements ContactsProvider {
  readonly id = "outlook" as const;
  readonly capabilities: ContactsProviderCapabilities = CAPABILITIES;

  async listOwnContacts(
    args: AccessTokenArgs,
  ): Promise<ReadonlyArray<NormalizedContact>> {
    return listGraphContacts({ accessToken: args.accessToken });
  }

  async listOtherContacts(
    _args: AccessTokenArgs,
  ): Promise<ReadonlyArray<NormalizedContact>> {
    return [];
  }

  async listFrequent(
    args: AccessTokenArgs,
  ): Promise<ReadonlyArray<NormalizedContact>> {
    return listGraphPeople({ accessToken: args.accessToken });
  }
}
