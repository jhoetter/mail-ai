// Calendar list + range read + RSVP / event mutation helpers.

import { baseUrl } from "./api";
import { dispatchCommand } from "./commands-client";

// Conferencing types this calendar's provider can mint. Read off
// CalendarProvider.capabilities.conferences on the server so the UI
// doesn't have to map provider strings to features.
export type CalendarConferenceCapability = "google" | "microsoft";

export interface CalendarCapabilities {
  conferences: CalendarConferenceCapability[];
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
  const res = await fetch(`${baseUrl()}/api/calendars`);
  if (!res.ok) throw new Error(`/api/calendars ${res.status}`);
  const data = (await res.json()) as {
    calendars: ReadonlyArray<Omit<CalendarSummary, "capabilities"> & {
      capabilities?: Partial<CalendarCapabilities>;
    }>;
  };
  // Normalize any older server response that hasn't shipped
  // capabilities yet so the rest of the UI can treat it as required.
  return data.calendars.map((c) => ({
    ...c,
    capabilities: { conferences: c.capabilities?.conferences ?? [] },
  }));
}

export async function syncCalendars(): Promise<void> {
  await fetch(`${baseUrl()}/api/calendars/sync`, { method: "POST" });
}

export async function listEvents(
  calendarId: string,
  from: Date,
  to: Date,
): Promise<EventSummary[]> {
  const u = new URL(
    `${baseUrl()}/api/calendars/${encodeURIComponent(calendarId)}/events`,
    typeof window === "undefined" ? "http://localhost" : window.location.href,
  );
  u.searchParams.set("from", from.toISOString());
  u.searchParams.set("to", to.toISOString());
  const res = await fetch(u.pathname + u.search);
  if (!res.ok) throw new Error(`/api/calendars events ${res.status}`);
  const data = (await res.json()) as { events: EventSummary[] };
  return data.events;
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
}

export async function createEvent(input: CreateEventInput): Promise<void> {
  await dispatchCommand({ type: "calendar:create-event", payload: input });
}

export async function updateEvent(
  eventId: string,
  patch: Partial<Omit<CreateEventInput, "calendarId">>,
): Promise<void> {
  await dispatchCommand({
    type: "calendar:update-event",
    payload: { eventId, ...patch },
  });
}

export async function deleteEvent(eventId: string): Promise<void> {
  await dispatchCommand({ type: "calendar:delete-event", payload: { eventId } });
}

export async function respondEvent(input: {
  eventId?: string;
  icalUid?: string;
  response: "accepted" | "declined" | "tentative";
  comment?: string;
}): Promise<void> {
  await dispatchCommand({ type: "calendar:respond", payload: input });
}
