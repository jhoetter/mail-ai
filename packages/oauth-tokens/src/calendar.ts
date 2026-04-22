// Calendar REST helpers for Google Calendar + Microsoft Graph.
//
// We expose only what the mail-ai overlay needs at v1:
//   - list calendars (so the user can pick visible ones)
//   - list events in a date range (the calendar grid + .ics RSVP card)
//   - create / patch / delete events (Phase 8 composer)
//   - respond to an invite (Phase 7 RSVP)
//
// All shapes are normalised to the `NormalizedEvent` we persist in
// `events.attendees_json` so the rest of the app doesn't have to fork
// per-provider.

const GOOGLE_CAL_BASE = "https://www.googleapis.com/calendar/v3";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export interface NormalizedCalendar {
  readonly providerCalendarId: string;
  readonly name: string;
  readonly color: string | null;
  readonly isPrimary: boolean;
}

export interface NormalizedAttendee {
  readonly email: string;
  readonly name?: string;
  readonly response?: "accepted" | "declined" | "tentative" | "needsAction";
  readonly organizer?: boolean;
}

export interface NormalizedEvent {
  readonly providerEventId: string;
  readonly icalUid: string | null;
  readonly summary: string | null;
  readonly description: string | null;
  readonly location: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly allDay: boolean;
  readonly attendees: NormalizedAttendee[];
  readonly organizerEmail: string | null;
  readonly responseStatus: string | null;
  readonly status: string | null;
  readonly raw: unknown;
}

// ----- Google Calendar ------------------------------------------------

interface GoogleCalListItem {
  id: string;
  summary: string;
  backgroundColor?: string;
  primary?: boolean;
}

export async function listGoogleCalendars(args: {
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<NormalizedCalendar[]> {
  const f = args.fetchImpl ?? fetch;
  const res = await f(`${GOOGLE_CAL_BASE}/users/me/calendarList`, {
    headers: { authorization: `Bearer ${args.accessToken}` },
  });
  if (!res.ok) throw new Error(`gcal list calendars failed: ${res.status}`);
  const json = (await res.json()) as { items?: GoogleCalListItem[] };
  return (json.items ?? []).map((c) => ({
    providerCalendarId: c.id,
    name: c.summary,
    color: c.backgroundColor ?? null,
    isPrimary: c.primary === true,
  }));
}

interface GoogleEvent {
  id: string;
  iCalUID?: string;
  summary?: string;
  description?: string;
  location?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: { email: string; displayName?: string; responseStatus?: string; organizer?: boolean }[];
  organizer?: { email?: string };
  status?: string;
  sequence?: number;
  hangoutLink?: string;
  conferenceData?: {
    entryPoints?: { entryPointType?: string; uri?: string }[];
    conferenceId?: string;
  };
}

// Shared shape for the "we just created/updated an event upstream" path.
// We always need the iCalUID (for our outgoing iMIP envelope) and the
// provider's SEQUENCE counter; conference URL is null when the caller
// didn't ask for a meeting.
export interface CreatedEvent {
  readonly providerEventId: string;
  readonly icalUid: string;
  readonly joinUrl: string | null;
  readonly sequence: number;
}

export async function listGoogleEvents(args: {
  accessToken: string;
  calendarId: string;
  timeMin: Date;
  timeMax: Date;
  fetchImpl?: typeof fetch;
}): Promise<NormalizedEvent[]> {
  const f = args.fetchImpl ?? fetch;
  const u = new URL(
    `${GOOGLE_CAL_BASE}/calendars/${encodeURIComponent(args.calendarId)}/events`,
  );
  u.searchParams.set("timeMin", args.timeMin.toISOString());
  u.searchParams.set("timeMax", args.timeMax.toISOString());
  u.searchParams.set("singleEvents", "true");
  u.searchParams.set("maxResults", "250");
  const res = await f(u.toString(), {
    headers: { authorization: `Bearer ${args.accessToken}` },
  });
  if (!res.ok) throw new Error(`gcal list events failed: ${res.status}`);
  const json = (await res.json()) as { items?: GoogleEvent[] };
  return (json.items ?? []).map(normaliseGoogleEvent);
}

function normaliseGoogleEvent(e: GoogleEvent): NormalizedEvent {
  const allDay = !!e.start.date && !e.start.dateTime;
  const startsAt = e.start.dateTime
    ? new Date(e.start.dateTime)
    : new Date(`${e.start.date}T00:00:00Z`);
  const endsAt = e.end.dateTime
    ? new Date(e.end.dateTime)
    : new Date(`${e.end.date}T00:00:00Z`);
  return {
    providerEventId: e.id,
    icalUid: e.iCalUID ?? null,
    summary: e.summary ?? null,
    description: e.description ?? null,
    location: e.location ?? null,
    startsAt,
    endsAt,
    allDay,
    attendees: (e.attendees ?? []).map((a) => ({
      email: a.email,
      ...(a.displayName ? { name: a.displayName } : {}),
      ...(a.responseStatus
        ? {
            response: a.responseStatus as
              | "accepted"
              | "declined"
              | "tentative"
              | "needsAction",
          }
        : {}),
      ...(a.organizer ? { organizer: a.organizer } : {}),
    })),
    organizerEmail: e.organizer?.email ?? null,
    responseStatus: null,
    status: e.status ?? null,
    raw: e,
  };
}

export async function createGoogleEvent(args: {
  accessToken: string;
  calendarId: string;
  summary: string;
  description?: string;
  location?: string;
  startsAt: Date;
  endsAt: Date;
  allDay?: boolean;
  attendees?: string[];
  // When set, ask Google to mint a Meet conference and embed it in the
  // returned event. Requires the calendar.events scope plus the
  // `conferenceDataVersion=1` query param we send below.
  withGoogleMeet?: boolean;
  // Defaults to "none" because we send our own RFC 5546 invite; Google
  // would otherwise email attendees as well, producing a duplicate.
  sendUpdates?: "all" | "externalOnly" | "none";
  fetchImpl?: typeof fetch;
}): Promise<CreatedEvent> {
  const f = args.fetchImpl ?? fetch;
  const body: Record<string, unknown> = {
    summary: args.summary,
    description: args.description,
    location: args.location,
    start: args.allDay
      ? { date: args.startsAt.toISOString().slice(0, 10) }
      : { dateTime: args.startsAt.toISOString() },
    end: args.allDay
      ? { date: args.endsAt.toISOString().slice(0, 10) }
      : { dateTime: args.endsAt.toISOString() },
  };
  if (args.attendees && args.attendees.length > 0) {
    body["attendees"] = args.attendees.map((e) => ({ email: e }));
  }
  if (args.withGoogleMeet) {
    body["conferenceData"] = {
      createRequest: {
        requestId: `mailai-${cryptoRandomId()}`,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    };
  }
  const url = new URL(
    `${GOOGLE_CAL_BASE}/calendars/${encodeURIComponent(args.calendarId)}/events`,
  );
  if (args.withGoogleMeet) {
    url.searchParams.set("conferenceDataVersion", "1");
  }
  url.searchParams.set("sendUpdates", args.sendUpdates ?? "none");
  const res = await f(url.toString(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${args.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`gcal create event failed: ${res.status}`);
  const json = (await res.json()) as GoogleEvent;
  return {
    providerEventId: json.id,
    icalUid: json.iCalUID ?? json.id,
    joinUrl: pickGoogleJoinUrl(json),
    sequence: json.sequence ?? 0,
  };
}

function pickGoogleJoinUrl(e: GoogleEvent): string | null {
  if (e.hangoutLink) return e.hangoutLink;
  const ep = e.conferenceData?.entryPoints?.find(
    (p) => p.entryPointType === "video",
  );
  return ep?.uri ?? null;
}

// Tiny URL-safe random id for Google's `requestId`. Crypto-safe and
// short; we don't want to pull in another dep just for this one call.
function cryptoRandomId(): string {
  // Node's webcrypto is always present on the supported runtimes; the
  // type isn't always picked up from lib.dom though, so we route via
  // the `unknown` -> typed call without naming `Crypto`.
  const c = (globalThis as unknown as { crypto: { getRandomValues(b: Uint8Array): Uint8Array } }).crypto;
  const bytes = new Uint8Array(8);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Fetch a Google event so callers can read the current SEQUENCE
// counter before issuing an update/cancel — RFC 5546 requires the
// outgoing iTIP message's SEQUENCE to monotonically increase.
export async function getGoogleEvent(args: {
  accessToken: string;
  calendarId: string;
  providerEventId: string;
  fetchImpl?: typeof fetch;
}): Promise<{ icalUid: string; sequence: number; joinUrl: string | null }> {
  const f = args.fetchImpl ?? fetch;
  const res = await f(
    `${GOOGLE_CAL_BASE}/calendars/${encodeURIComponent(args.calendarId)}/events/${encodeURIComponent(args.providerEventId)}`,
    { headers: { authorization: `Bearer ${args.accessToken}` } },
  );
  if (!res.ok) throw new Error(`gcal get event failed: ${res.status}`);
  const json = (await res.json()) as GoogleEvent;
  return {
    icalUid: json.iCalUID ?? args.providerEventId,
    sequence: json.sequence ?? 0,
    joinUrl: pickGoogleJoinUrl(json),
  };
}

export async function patchGoogleEvent(args: {
  accessToken: string;
  calendarId: string;
  providerEventId: string;
  patch: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const f = args.fetchImpl ?? fetch;
  const res = await f(
    `${GOOGLE_CAL_BASE}/calendars/${encodeURIComponent(args.calendarId)}/events/${encodeURIComponent(args.providerEventId)}`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${args.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(args.patch),
    },
  );
  if (!res.ok) throw new Error(`gcal patch event failed: ${res.status}`);
}

export async function deleteGoogleEvent(args: {
  accessToken: string;
  calendarId: string;
  providerEventId: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const f = args.fetchImpl ?? fetch;
  const res = await f(
    `${GOOGLE_CAL_BASE}/calendars/${encodeURIComponent(args.calendarId)}/events/${encodeURIComponent(args.providerEventId)}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${args.accessToken}` },
    },
  );
  // 410 (Gone) is fine — already deleted upstream.
  if (!res.ok && res.status !== 410) {
    throw new Error(`gcal delete event failed: ${res.status}`);
  }
}

export async function respondGoogleEvent(args: {
  accessToken: string;
  calendarId: string;
  providerEventId: string;
  attendeeEmail: string;
  response: "accepted" | "declined" | "tentative";
  fetchImpl?: typeof fetch;
}): Promise<void> {
  // Google's API requires the full attendee list on PATCH; without
  // refetching the event we'd risk wiping co-invitees. So: GET, mutate
  // our own row, PATCH back.
  const f = args.fetchImpl ?? fetch;
  const getRes = await f(
    `${GOOGLE_CAL_BASE}/calendars/${encodeURIComponent(args.calendarId)}/events/${encodeURIComponent(args.providerEventId)}`,
    { headers: { authorization: `Bearer ${args.accessToken}` } },
  );
  if (!getRes.ok) throw new Error(`gcal get event failed: ${getRes.status}`);
  const event = (await getRes.json()) as { attendees?: { email: string; responseStatus?: string }[] };
  const attendees = (event.attendees ?? []).map((a) =>
    a.email.toLowerCase() === args.attendeeEmail.toLowerCase()
      ? { ...a, responseStatus: args.response }
      : a,
  );
  await patchGoogleEvent({
    accessToken: args.accessToken,
    calendarId: args.calendarId,
    providerEventId: args.providerEventId,
    patch: { attendees },
  });
}

// ----- Microsoft Graph -----------------------------------------------

interface GraphCalListItem {
  id: string;
  name: string;
  hexColor?: string;
  isDefaultCalendar?: boolean;
}

export async function listGraphCalendars(args: {
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<NormalizedCalendar[]> {
  const f = args.fetchImpl ?? fetch;
  const res = await f(`${GRAPH_BASE}/me/calendars`, {
    headers: { authorization: `Bearer ${args.accessToken}` },
  });
  if (!res.ok) throw new Error(`graph list calendars failed: ${res.status}`);
  const json = (await res.json()) as { value?: GraphCalListItem[] };
  return (json.value ?? []).map((c) => ({
    providerCalendarId: c.id,
    name: c.name,
    color: c.hexColor ?? null,
    isPrimary: c.isDefaultCalendar === true,
  }));
}

interface GraphEvent {
  id: string;
  iCalUId?: string;
  subject?: string;
  bodyPreview?: string;
  location?: { displayName?: string };
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
  isAllDay?: boolean;
  attendees?: {
    emailAddress: { address: string; name?: string };
    status?: { response?: string };
  }[];
  organizer?: { emailAddress?: { address?: string } };
  responseStatus?: { response?: string };
  showAs?: string;
  isOnlineMeeting?: boolean;
  onlineMeetingProvider?: string;
  onlineMeeting?: { joinUrl?: string };
  onlineMeetingUrl?: string;
}

export async function listGraphEvents(args: {
  accessToken: string;
  calendarId: string;
  timeMin: Date;
  timeMax: Date;
  fetchImpl?: typeof fetch;
}): Promise<NormalizedEvent[]> {
  const f = args.fetchImpl ?? fetch;
  const u = new URL(
    `${GRAPH_BASE}/me/calendars/${encodeURIComponent(args.calendarId)}/calendarView`,
  );
  u.searchParams.set("startDateTime", args.timeMin.toISOString());
  u.searchParams.set("endDateTime", args.timeMax.toISOString());
  u.searchParams.set("$top", "250");
  const res = await f(u.toString(), {
    headers: {
      authorization: `Bearer ${args.accessToken}`,
      Prefer: 'outlook.timezone="UTC"',
    },
  });
  if (!res.ok) throw new Error(`graph list events failed: ${res.status}`);
  const json = (await res.json()) as { value?: GraphEvent[] };
  return (json.value ?? []).map(normaliseGraphEvent);
}

function normaliseGraphEvent(e: GraphEvent): NormalizedEvent {
  return {
    providerEventId: e.id,
    icalUid: e.iCalUId ?? null,
    summary: e.subject ?? null,
    description: e.bodyPreview ?? null,
    location: e.location?.displayName ?? null,
    startsAt: new Date(`${e.start.dateTime}Z`),
    endsAt: new Date(`${e.end.dateTime}Z`),
    allDay: e.isAllDay === true,
    attendees: (e.attendees ?? []).map((a) => ({
      email: a.emailAddress.address,
      ...(a.emailAddress.name ? { name: a.emailAddress.name } : {}),
      ...(a.status?.response
        ? { response: graphResponseToNorm(a.status.response) }
        : {}),
    })),
    organizerEmail: e.organizer?.emailAddress?.address ?? null,
    responseStatus: e.responseStatus?.response ?? null,
    status: e.showAs ?? null,
    raw: e,
  };
}

function graphResponseToNorm(
  r: string,
): "accepted" | "declined" | "tentative" | "needsAction" {
  switch (r) {
    case "accepted":
    case "organizer":
      return "accepted";
    case "declined":
      return "declined";
    case "tentativelyAccepted":
      return "tentative";
    default:
      return "needsAction";
  }
}

export async function createGraphEvent(args: {
  accessToken: string;
  calendarId: string;
  summary: string;
  description?: string;
  location?: string;
  startsAt: Date;
  endsAt: Date;
  attendees?: string[];
  // When set, ask Graph to provision a Teams meeting for the event.
  // Requires the OnlineMeetings.ReadWrite delegated scope.
  withMicrosoftTeams?: boolean;
  // Graph's create endpoint doesn't take an explicit "don't email
  // attendees" flag — its model is that the create itself never sends
  // a meeting invite; only `forward` and `cancel` do. We document the
  // option here for symmetry with the Google path.
  fetchImpl?: typeof fetch;
}): Promise<CreatedEvent> {
  const f = args.fetchImpl ?? fetch;
  const body: Record<string, unknown> = {
    subject: args.summary,
    body: { contentType: "text", content: args.description ?? "" },
    start: { dateTime: args.startsAt.toISOString(), timeZone: "UTC" },
    end: { dateTime: args.endsAt.toISOString(), timeZone: "UTC" },
  };
  if (args.location) body["location"] = { displayName: args.location };
  if (args.attendees && args.attendees.length > 0) {
    body["attendees"] = args.attendees.map((e) => ({
      emailAddress: { address: e },
      type: "required",
    }));
  }
  if (args.withMicrosoftTeams) {
    body["isOnlineMeeting"] = true;
    body["onlineMeetingProvider"] = "teamsForBusiness";
  }
  const res = await f(
    `${GRAPH_BASE}/me/calendars/${encodeURIComponent(args.calendarId)}/events`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${args.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`graph create event failed: ${res.status}`);
  const json = (await res.json()) as GraphEvent;
  return {
    providerEventId: json.id,
    icalUid: json.iCalUId ?? json.id,
    joinUrl: json.onlineMeeting?.joinUrl ?? json.onlineMeetingUrl ?? null,
    sequence: 0,
  };
}

// Like getGoogleEvent: fetch the current SEQUENCE counter (Graph doesn't
// expose it directly, so we keep our own — see CalendarRepository) plus
// the canonical iCalUId so updates and cancels stay UID-stable.
export async function getGraphEvent(args: {
  accessToken: string;
  providerEventId: string;
  fetchImpl?: typeof fetch;
}): Promise<{ icalUid: string; joinUrl: string | null }> {
  const f = args.fetchImpl ?? fetch;
  const res = await f(
    `${GRAPH_BASE}/me/events/${encodeURIComponent(args.providerEventId)}`,
    { headers: { authorization: `Bearer ${args.accessToken}` } },
  );
  if (!res.ok) throw new Error(`graph get event failed: ${res.status}`);
  const json = (await res.json()) as GraphEvent;
  return {
    icalUid: json.iCalUId ?? args.providerEventId,
    joinUrl: json.onlineMeeting?.joinUrl ?? json.onlineMeetingUrl ?? null,
  };
}

export async function patchGraphEvent(args: {
  accessToken: string;
  providerEventId: string;
  patch: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const f = args.fetchImpl ?? fetch;
  const res = await f(
    `${GRAPH_BASE}/me/events/${encodeURIComponent(args.providerEventId)}`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${args.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(args.patch),
    },
  );
  if (!res.ok) throw new Error(`graph patch event failed: ${res.status}`);
}

export async function deleteGraphEvent(args: {
  accessToken: string;
  providerEventId: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const f = args.fetchImpl ?? fetch;
  const res = await f(
    `${GRAPH_BASE}/me/events/${encodeURIComponent(args.providerEventId)}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${args.accessToken}` },
    },
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`graph delete event failed: ${res.status}`);
  }
}

export async function respondGraphEvent(args: {
  accessToken: string;
  providerEventId: string;
  response: "accepted" | "declined" | "tentative";
  comment?: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const f = args.fetchImpl ?? fetch;
  const action =
    args.response === "accepted"
      ? "accept"
      : args.response === "declined"
        ? "decline"
        : "tentativelyAccept";
  const res = await f(
    `${GRAPH_BASE}/me/events/${encodeURIComponent(args.providerEventId)}/${action}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${args.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        comment: args.comment ?? "",
        sendResponse: true,
      }),
    },
  );
  if (!res.ok) throw new Error(`graph respond event failed: ${res.status}`);
}
