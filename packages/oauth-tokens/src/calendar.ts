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
  fetchImpl?: typeof fetch;
}): Promise<{ providerEventId: string }> {
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
  const res = await f(
    `${GOOGLE_CAL_BASE}/calendars/${encodeURIComponent(args.calendarId)}/events`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${args.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`gcal create event failed: ${res.status}`);
  const json = (await res.json()) as { id: string };
  return { providerEventId: json.id };
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
  fetchImpl?: typeof fetch;
}): Promise<{ providerEventId: string }> {
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
  const json = (await res.json()) as { id: string };
  return { providerEventId: json.id };
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
