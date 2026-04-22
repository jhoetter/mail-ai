// OutlookCalendarAdapter — implements CalendarProvider against
// Microsoft Graph. Symmetric with GoogleCalendarAdapter; thin
// wrapper around the helpers in calendar.ts so the migration to
// the port model is purely structural.

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
  createGraphEvent,
  deleteGraphEvent,
  getGraphEvent,
  listGraphCalendars,
  listGraphEvents,
  patchGraphEvent,
  respondGraphEvent,
} from "../calendar.js";

const CAPABILITIES: CalendarProviderCapabilities = {
  mutate: true,
  conferences: ["microsoft"],
  respondTentative: true,
};

export class OutlookCalendarAdapter implements CalendarProvider {
  readonly id = "outlook" as const;
  readonly capabilities: CalendarProviderCapabilities = CAPABILITIES;

  async listCalendars(
    args: AccessTokenArgs,
  ): Promise<ReadonlyArray<NormalizedCalendar>> {
    return listGraphCalendars({ accessToken: args.accessToken });
  }

  async listEvents(
    args: AccessTokenArgs & ListEventsArgs,
  ): Promise<ReadonlyArray<NormalizedEvent>> {
    return listGraphEvents({
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
    void args.calendarId; // graph addresses events by id alone
    const out = await getGraphEvent({
      accessToken: args.accessToken,
      providerEventId: args.providerEventId,
    });
    return {
      icalUid: out.icalUid,
      // Graph doesn't expose SEQUENCE; the CalendarRepository keeps
      // a local counter and the handler increments it before
      // emitting an iMIP update.
      sequence: 0,
      joinUrl: out.joinUrl,
    };
  }

  async createEvent(
    args: AccessTokenArgs & CreateEventArgs,
  ): Promise<CreatedEvent> {
    if (args.conference === "google") {
      throw new Error(
        "outlook calendar adapter cannot provision a Google Meet meeting",
      );
    }
    return createGraphEvent({
      accessToken: args.accessToken,
      calendarId: args.calendarId,
      summary: args.summary,
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.location !== undefined ? { location: args.location } : {}),
      startsAt: args.startsAt,
      endsAt: args.endsAt,
      ...(args.attendees ? { attendees: [...args.attendees] } : {}),
      ...(args.conference === "microsoft" ? { withMicrosoftTeams: true } : {}),
    });
  }

  async patchEvent(args: AccessTokenArgs & PatchEventArgs): Promise<void> {
    void args.calendarId;
    const p = args.patch;
    const body: Record<string, unknown> = {};
    if (p.summary !== undefined) body["subject"] = p.summary;
    if (p.description !== undefined) {
      body["body"] = { contentType: "text", content: p.description };
    }
    if (p.location !== undefined) {
      body["location"] = { displayName: p.location };
    }
    if (p.startsAt) {
      body["start"] = { dateTime: p.startsAt.toISOString(), timeZone: "UTC" };
    }
    if (p.endsAt) {
      body["end"] = { dateTime: p.endsAt.toISOString(), timeZone: "UTC" };
    }
    await patchGraphEvent({
      accessToken: args.accessToken,
      providerEventId: args.providerEventId,
      patch: body,
    });
  }

  async deleteEvent(args: AccessTokenArgs & DeleteEventArgs): Promise<void> {
    void args.calendarId;
    await deleteGraphEvent({
      accessToken: args.accessToken,
      providerEventId: args.providerEventId,
    });
  }

  async respondEvent(args: AccessTokenArgs & RespondEventArgs): Promise<void> {
    void args.calendarId;
    void args.attendeeEmail; // Graph addresses the response to the authenticated user
    await respondGraphEvent({
      accessToken: args.accessToken,
      providerEventId: args.providerEventId,
      response: args.response,
      ...(args.comment !== undefined ? { comment: args.comment } : {}),
    });
  }
}
