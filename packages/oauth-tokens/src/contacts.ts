// Recipient autocomplete data sources: Google People API and
// Microsoft Graph. Mirrors the shape of `calendar.ts` — one
// normalized type, four paginated fetchers, `fetchImpl` injection so
// tests can mock without a network.
//
// We expose three "sources" so callers (and the suggest endpoint)
// can rank contacts by how close they are to "the person Gmail
// would have suggested":
//
//   - 'my'     → explicit address-book entries the user maintains
//                themselves (Google `people/me/connections`,
//                Graph `/me/contacts`).
//   - 'other'  → Google's auto-collected senders/recipients
//                (`otherContacts`). This is the population that
//                makes "type 'jt' → suggest jt.hoetter@gmail.com"
//                work in Gmail without the user ever saving anyone.
//   - 'people' → Graph's intelligent ranked suggestions
//                (`/me/people`); the closest analogue of 'other'
//                for Outlook accounts. Includes frequent
//                collaborators inferred from mail + calendar.

const GOOGLE_PEOPLE_BASE = "https://people.googleapis.com/v1";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

// Hard cap on pagination so a runaway provider response can't keep
// us looping forever. 25 pages × 1000 entries/page = 25k contacts,
// which is comfortably above any realistic personal address book.
const MAX_PAGES = 25;

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
  readonly lastInteractionAt?: Date;
}

// ----- Google People API ---------------------------------------------

interface GoogleEmailAddress {
  value?: string;
  type?: string;
  metadata?: { primary?: boolean; source?: { id?: string } };
}

interface GoogleName {
  displayName?: string;
}

interface GooglePerson {
  resourceName?: string;
  etag?: string;
  emailAddresses?: GoogleEmailAddress[];
  names?: GoogleName[];
  metadata?: { sources?: { updateTime?: string }[] };
}

interface GoogleListConnectionsResponse {
  connections?: GooglePerson[];
  nextPageToken?: string;
}

interface GoogleOtherContactsResponse {
  otherContacts?: GooglePerson[];
  nextPageToken?: string;
}

export async function listGoogleConnections(args: {
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<NormalizedContact[]> {
  const f = args.fetchImpl ?? fetch;
  const out: NormalizedContact[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const u = new URL(`${GOOGLE_PEOPLE_BASE}/people/me/connections`);
    u.searchParams.set("personFields", "names,emailAddresses,metadata");
    u.searchParams.set("pageSize", "1000");
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const res = await f(u.toString(), {
      headers: { authorization: `Bearer ${args.accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`google connections list failed: ${res.status}`);
    }
    const json = (await res.json()) as GoogleListConnectionsResponse;
    for (const p of json.connections ?? []) {
      const c = normalizeGooglePerson(p, "my");
      if (c) out.push(c);
    }
    if (!json.nextPageToken) return out;
    pageToken = json.nextPageToken;
  }
  return out;
}

export async function listGoogleOtherContacts(args: {
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<NormalizedContact[]> {
  const f = args.fetchImpl ?? fetch;
  const out: NormalizedContact[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const u = new URL(`${GOOGLE_PEOPLE_BASE}/otherContacts`);
    // `readMask` (not `personFields`) is the otherContacts equivalent.
    u.searchParams.set("readMask", "names,emailAddresses,metadata");
    u.searchParams.set("pageSize", "1000");
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const res = await f(u.toString(), {
      headers: { authorization: `Bearer ${args.accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`google otherContacts list failed: ${res.status}`);
    }
    const json = (await res.json()) as GoogleOtherContactsResponse;
    for (const p of json.otherContacts ?? []) {
      const c = normalizeGooglePerson(p, "other");
      if (c) out.push(c);
    }
    if (!json.nextPageToken) return out;
    pageToken = json.nextPageToken;
  }
  return out;
}

function normalizeGooglePerson(
  p: GooglePerson,
  source: ContactSource,
): NormalizedContact | null {
  const emails = (p.emailAddresses ?? [])
    .map((e) => {
      const address = (e.value ?? "").trim();
      if (!address) return null;
      const out: NormalizedContactEmail = { address };
      if (e.type) (out as { type?: string }).type = e.type;
      if (e.metadata?.primary) (out as { primary?: boolean }).primary = true;
      return out;
    })
    .filter((e): e is NormalizedContactEmail => e !== null);
  if (emails.length === 0) return null;
  // resourceName is the canonical id we get back from People API
  // (`people/c123` for connections, `otherContacts/c123` for the
  // auto-collected set). It's globally unique within the account so
  // we use it directly as the provider key.
  const providerContactId = p.resourceName ?? `people/${emails[0]!.address}`;
  const displayName = p.names?.[0]?.displayName ?? null;
  const updateTime = p.metadata?.sources?.[0]?.updateTime;
  const lastInteractionAt = updateTime ? new Date(updateTime) : undefined;
  const out: NormalizedContact = {
    providerContactId,
    source,
    displayName,
    emails,
    ...(lastInteractionAt ? { lastInteractionAt } : {}),
  };
  return out;
}

// ----- Microsoft Graph ----------------------------------------------

interface GraphEmail {
  address?: string;
  name?: string;
}

interface GraphContact {
  id?: string;
  displayName?: string;
  emailAddresses?: GraphEmail[];
  lastModifiedDateTime?: string;
}

interface GraphContactsResponse {
  value?: GraphContact[];
  "@odata.nextLink"?: string;
}

interface GraphScoredEmail {
  address?: string;
  relevanceScore?: number;
}

interface GraphPerson {
  id?: string;
  displayName?: string;
  scoredEmailAddresses?: GraphScoredEmail[];
}

interface GraphPeopleResponse {
  value?: GraphPerson[];
  "@odata.nextLink"?: string;
}

export async function listGraphContacts(args: {
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<NormalizedContact[]> {
  const f = args.fetchImpl ?? fetch;
  const out: NormalizedContact[] = [];
  let next: string | undefined =
    `${GRAPH_BASE}/me/contacts?$top=999&$select=id,displayName,emailAddresses,lastModifiedDateTime`;
  for (let page = 0; page < MAX_PAGES && next; page += 1) {
    const res = await f(next, {
      headers: { authorization: `Bearer ${args.accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`graph contacts list failed: ${res.status}`);
    }
    const json = (await res.json()) as GraphContactsResponse;
    for (const c of json.value ?? []) {
      const norm = normalizeGraphContact(c);
      if (norm) out.push(norm);
    }
    next = json["@odata.nextLink"] ?? undefined;
  }
  return out;
}

function normalizeGraphContact(c: GraphContact): NormalizedContact | null {
  const emails = (c.emailAddresses ?? [])
    .map((e) => {
      const address = (e.address ?? "").trim();
      if (!address) return null;
      return { address } as NormalizedContactEmail;
    })
    .filter((e): e is NormalizedContactEmail => e !== null);
  if (emails.length === 0) return null;
  if (!c.id) return null;
  const lastInteractionAt = c.lastModifiedDateTime
    ? new Date(c.lastModifiedDateTime)
    : undefined;
  const out: NormalizedContact = {
    providerContactId: c.id,
    source: "my",
    displayName: c.displayName ?? null,
    emails,
    ...(lastInteractionAt ? { lastInteractionAt } : {}),
  };
  return out;
}

export async function listGraphPeople(args: {
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<NormalizedContact[]> {
  const f = args.fetchImpl ?? fetch;
  const out: NormalizedContact[] = [];
  let next: string | undefined =
    `${GRAPH_BASE}/me/people?$top=100&$select=id,displayName,scoredEmailAddresses`;
  for (let page = 0; page < MAX_PAGES && next; page += 1) {
    const res = await f(next, {
      headers: { authorization: `Bearer ${args.accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`graph people list failed: ${res.status}`);
    }
    const json = (await res.json()) as GraphPeopleResponse;
    for (const p of json.value ?? []) {
      const norm = normalizeGraphPerson(p);
      if (norm) out.push(norm);
    }
    next = json["@odata.nextLink"] ?? undefined;
  }
  return out;
}

function normalizeGraphPerson(p: GraphPerson): NormalizedContact | null {
  const scored = (p.scoredEmailAddresses ?? []).filter(
    (e): e is GraphScoredEmail & { address: string } =>
      typeof e.address === "string" && e.address.trim().length > 0,
  );
  if (scored.length === 0) return null;
  if (!p.id) return null;
  // Sort by Graph's relevance score (higher is more relevant) so the
  // first email becomes our `primary_email`.
  scored.sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0));
  const emails: NormalizedContactEmail[] = scored.map((e, i) => ({
    address: e.address,
    ...(i === 0 ? { primary: true } : {}),
  }));
  const out: NormalizedContact = {
    providerContactId: p.id,
    source: "people",
    displayName: p.displayName ?? null,
    emails,
  };
  return out;
}

// ----- helpers shared by the suggest endpoint -----------------------

// Pick the address that should land in `primary_email`. Prefers the
// flag the provider gave us, falls back to the first non-empty entry.
// Lower-cased so the index-backed prefix lookup in the repo is a
// straight ILIKE without a per-row lower() at query time.
export function pickPrimaryEmail(
  emails: readonly NormalizedContactEmail[],
): string | null {
  const primary = emails.find((e) => e.primary);
  const chosen = (primary ?? emails[0])?.address;
  if (!chosen) return null;
  return chosen.trim().toLowerCase();
}
