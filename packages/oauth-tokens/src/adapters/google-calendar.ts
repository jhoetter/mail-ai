// GoogleCalendarAdapter — implements CalendarProvider against the
// Google Calendar v3 API. The adapter is a thin shell around the
// existing helpers in calendar.ts so the migration to the port
// model doesn't change wire behaviour.

import type {
  AccessTokenArgs,
  CalendarProvider,
  CalendarProviderCapabilities,
} from "@mailai/providers";
import type {
  CreateEventArgs,
  CreatedEvent,
  DeleteEventArgs,
  EventMetadata,
  ListEventsArgs,
  NormalizedCalendar,
  NormalizedEvent,
  PatchEventArgs,
  RespondEventArgs,
} from "@mailai/providers/calendar";
import {
  createGoogleEvent,
  deleteGoogleEvent,
  getGoogleEvent,
  listGoogleCalendars,
  listGoogleEvents,
  patchGoogleEvent,
  respondGoogleEvent,
} from "../calendar.js";

const CAPABILITIES: CalendarProviderCapabilities = {
  mutate: true,
  conferences: ["google"],
  respondTentative: true,
};

export class GoogleCalendarAdapter implements CalendarProvider {
  readonly id = "google-mail" as const;
  readonly capabilities: CalendarProviderCapabilities = CAPABILITIES;

  async listCalendars(
    args: AccessTokenArgs,
  ): Promise<ReadonlyArray<NormalizedCalendar>> {
    return listGoogleCalendars({ accessToken: args.accessToken });
  }

  async listEvents(
    args: AccessTokenArgs & ListEventsArgs,
  ): Promise<ReadonlyArray<NormalizedEvent>> {
    return listGoogleEvents({
      accessToken: args.accessToken,
      calendarId: args.calendarId,
      timeMin: args.timeMin,
      timeMax: args.timeMax,
    });
  }

  async getEvent(
    args: AccessTokenArgs & {
      calendarId: string;
      providerEventId: string;
    },
  ): Promise<EventMetadata> {
    const out = await getGoogleEvent({
      accessToken: args.accessToken,
      calendarId: args.calendarId,
      providerEventId: args.providerEventId,
    });
    return {
      icalUid: out.icalUid,
      sequence: out.sequence,
      joinUrl: out.joinUrl,
    };
  }

  async createEvent(
    args: AccessTokenArgs & CreateEventArgs,
  ): Promise<CreatedEvent> {
    if (args.conference === "microsoft") {
      throw new Error(
        "google-mail calendar adapter cannot provision a Microsoft Teams meeting",
      );
    }
    return createGoogleEvent({
      accessToken: args.accessToken,
      calendarId: args.calendarId,
      summary: args.summary,
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.location !== undefined ? { location: args.location } : {}),
      startsAt: args.startsAt,
      endsAt: args.endsAt,
      ...(args.allDay !== undefined ? { allDay: args.allDay } : {}),
      ...(args.attendees ? { attendees: [...args.attendees] } : {}),
      ...(args.conference === "google" ? { withGoogleMeet: true } : {}),
      // Always "none": the calendar handler emits its own RFC 5546
      // iMIP envelope and we don't want Google to send a duplicate
      // notification email.
      sendUpdates: "none",
    });
  }

  async patchEvent(args: AccessTokenArgs & PatchEventArgs): Promise<void> {
    const p = args.patch;
    const body: Record<string, unknown> = {};
    if (p.summary !== undefined) body["summary"] = p.summary;
    if (p.description !== undefined) body["description"] = p.description;
    if (p.location !== undefined) body["location"] = p.location;
    if (p.startsAt) body["start"] = { dateTime: p.startsAt.toISOString() };
    if (p.endsAt) body["end"] = { dateTime: p.endsAt.toISOString() };
    await patchGoogleEvent({
      accessToken: args.accessToken,
      calendarId: args.calendarId,
      providerEventId: args.providerEventId,
      patch: body,
    });
  }

  async deleteEvent(args: AccessTokenArgs & DeleteEventArgs): Promise<void> {
    await deleteGoogleEvent({
      accessToken: args.accessToken,
      calendarId: args.calendarId,
      providerEventId: args.providerEventId,
    });
  }

  async respondEvent(args: AccessTokenArgs & RespondEventArgs): Promise<void> {
    await respondGoogleEvent({
      accessToken: args.accessToken,
      calendarId: args.calendarId,
      providerEventId: args.providerEventId,
      attendeeEmail: args.attendeeEmail,
      response: args.response,
    });
  }
}
