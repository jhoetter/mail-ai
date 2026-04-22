// Calendar list + range read + RSVP / event mutation helpers.

import { baseUrl } from "./api";
import { dispatchCommand } from "./commands-client";

export interface CalendarSummary {
  id: string;
  name: string;
  color: string | null;
  provider: "google-mail" | "outlook";
  isPrimary: boolean;
  isVisible: boolean;
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
}

export async function listCalendars(): Promise<CalendarSummary[]> {
  const res = await fetch(`${baseUrl()}/api/calendars`);
  if (!res.ok) throw new Error(`/api/calendars ${res.status}`);
  const data = (await res.json()) as { calendars: CalendarSummary[] };
  return data.calendars;
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
