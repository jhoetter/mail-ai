// Calendar list + range read + RSVP / event mutation helpers.

import { apiFetch } from "./api";
import { dispatchCommand } from "./commands-client";

// Conferencing types this calendar's provider can mint. Read off
// CalendarProvider.capabilities.conferences on the server so the UI
// doesn't have to map provider strings to features.
export type CalendarConferenceCapability = "google" | "microsoft";

export type CalendarEditScope = "single" | "following" | "series";

export interface CalendarCapabilities {
  conferences: CalendarConferenceCapability[];
  recurrence: boolean;
  editScopes: CalendarEditScope[];
  patchAttendees: boolean;
  timeZones: boolean;
}

// RFC 5545 RRULE subset matched to the agent schema.
export interface RecurrenceRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval?: number;
  count?: number;
  until?: string;
  byday?: ReadonlyArray<"MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU">;
  bymonthday?: ReadonlyArray<number>;
}

export interface CalendarSummary {
  id: string;
  name: string;
  color: string | null;
  provider: "google-mail" | "outlook";
  isPrimary: boolean;
  isVisible: boolean;
  // Always present; defaults to an empty set on calendars without a
  // registered adapter so the UI degrades to "no conferences".
  capabilities: CalendarCapabilities;
}

export interface EventAttendee {
  email: string;
  name?: string;
  response?: "accepted" | "declined" | "tentative" | "needsAction";
  organizer?: boolean;
}

export interface EventSummary {
  id: string;
  providerEventId: string;
  icalUid: string | null;
  summary: string | null;
  description: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  attendees: EventAttendee[];
  organizerEmail: string | null;
  responseStatus: string | null;
  status: string | null;
  // Conferencing wired to this event. Both null when no meeting link
  // was attached at create time.
  meetingProvider?: "google-meet" | "ms-teams" | null;
  meetingJoinUrl?: string | null;
}

// Mirrors MeetingChoice on the server. 'gmeet' is gated to google-mail
// accounts and 'teams' to outlook; the dropdown disables the other.
export type MeetingChoice = "gmeet" | "teams" | "none";

export async function listCalendars(): Promise<CalendarSummary[]> {
  const res = await apiFetch(`/api/calendars`);
  if (!res.ok) throw new Error(`/api/calendars ${res.status}`);
  const data = (await res.json()) as {
    calendars: ReadonlyArray<
      Omit<CalendarSummary, "capabilities"> & {
        capabilities?: Partial<CalendarCapabilities>;
      }
    >;
  };
  // Normalize any older server response that hasn't shipped the full
  // capability set yet so the rest of the UI can treat it as required.
  return data.calendars.map((c) => ({
    ...c,
    capabilities: {
      conferences: c.capabilities?.conferences ?? [],
      recurrence: c.capabilities?.recurrence ?? false,
      editScopes: c.capabilities?.editScopes ?? ["single"],
      patchAttendees: c.capabilities?.patchAttendees ?? false,
      timeZones: c.capabilities?.timeZones ?? false,
    },
  }));
}

export type CalendarSyncIssueCode =
  | "missing_credentials"
  | "missing_adapter"
  | "auth_error"
  | "provider_error";

export interface CalendarSyncAccountResult {
  accountId: string;
  provider: string;
  email: string;
  status: "synced" | "skipped" | "error";
  calendarsSynced: number;
  code?: CalendarSyncIssueCode;
  message?: string;
}

export interface CalendarSyncResult {
  synced: number;
  accounts: CalendarSyncAccountResult[];
}

export async function syncCalendars(): Promise<CalendarSyncResult> {
  const res = await apiFetch(`/api/calendars/sync`, { method: "POST" });
  if (!res.ok) throw new Error(`/api/calendars/sync ${res.status}`);
  return (await res.json()) as CalendarSyncResult;
}

export async function setCalendarVisibility(id: string, isVisible: boolean): Promise<void> {
  const res = await apiFetch(`/api/calendars/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ isVisible }),
  });
  if (!res.ok) throw new Error(`/api/calendars PATCH ${res.status}`);
}

export async function listEvents(
  calendarId: string,
  from: Date,
  to: Date,
): Promise<EventSummary[]> {
  const params = new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString(),
  });
  const res = await apiFetch(
    `/api/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
  );
  if (!res.ok) throw new Error(`/api/calendars events ${res.status}`);
  const data = (await res.json()) as { events: EventSummary[] };
  return data.events;
}

// Fan-out version: every visible calendar in one round-trip. Returns
// events grouped by calendar id so the UI can colour them per
// calendar without a second join.
export interface EventsRangeResponse {
  from: string;
  to: string;
  groups: ReadonlyArray<{
    calendarId: string;
    events: EventSummary[];
  }>;
}

export async function listEventsRange(from: Date, to: Date): Promise<EventsRangeResponse> {
  const params = new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString(),
  });
  const res = await apiFetch(`/api/calendars/events?${params.toString()}`);
  if (!res.ok) throw new Error(`/api/calendars/events ${res.status}`);
  return (await res.json()) as EventsRangeResponse;
}

export interface CreateEventInput {
  calendarId: string;
  summary: string;
  description?: string;
  location?: string;
  startsAt: string;
  endsAt: string;
  allDay?: boolean;
  attendees?: string[];
  meeting?: MeetingChoice;
  timeZone?: string;
  recurrence?: RecurrenceRule;
}

export async function createEvent(input: CreateEventInput): Promise<void> {
  await dispatchCommand({ type: "calendar:create-event", payload: input });
}

export interface UpdateEventInput {
  summary?: string;
  description?: string;
  location?: string;
  startsAt?: string;
  endsAt?: string;
  allDay?: boolean;
  attendeesAdd?: string[];
  attendeesRemove?: string[];
  meeting?: MeetingChoice;
  recurrence?: RecurrenceRule | null;
  timeZone?: string;
  scope?: CalendarEditScope;
}

export async function updateEvent(eventId: string, patch: UpdateEventInput): Promise<void> {
  await dispatchCommand({
    type: "calendar:update-event",
    payload: { eventId, ...patch },
  });
}

export async function deleteEvent(eventId: string, scope?: CalendarEditScope): Promise<void> {
  await dispatchCommand({
    type: "calendar:delete-event",
    payload: { eventId, ...(scope ? { scope } : {}) },
  });
}

export async function respondEvent(input: {
  eventId?: string;
  icalUid?: string;
  response: "accepted" | "declined" | "tentative";
  comment?: string;
}): Promise<void> {
  await dispatchCommand({ type: "calendar:respond", payload: input });
}

export async function respondInviteFromIcs(input: {
  messageId: string;
  attachmentId?: string;
  response: "accepted" | "declined" | "tentative";
  comment?: string;
}): Promise<void> {
  await dispatchCommand({ type: "calendar:respond-from-ics", payload: input });
}

// Wrapper for /api/contacts/suggest used by ContactPicker. Returns
// the normalized item shape the picker expects.
export interface ContactsSuggestItem {
  id: string;
  email: string;
  name?: string;
  source?: string;
}

export async function suggestContacts(q: string): Promise<ContactsSuggestItem[]> {
  if (q.trim().length === 0) return [];
  const params = new URLSearchParams({
    q: q.trim(),
    limit: "8",
  });
  const res = await apiFetch(`/api/contacts/suggest?${params.toString()}`);
  if (!res.ok) return [];
  const data = (await res.json()) as {
    items: ReadonlyArray<{ id: string; email: string; name?: string; source?: string }>;
  };
  return [...data.items];
}
