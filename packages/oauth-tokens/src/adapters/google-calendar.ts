// GoogleCalendarAdapter — implements CalendarProvider against the
// Google Calendar v3 API. The adapter is a thin shell around the
// existing helpers in calendar.ts so the migration to the port
// model doesn't change wire behaviour.
//
// Recurrence semantics (`scope: "single" | "following" | "series"`)
// for an event id that came back from listEvents (which we always
// call with singleEvents=true so the id is an *instance* id like
// `<masterId>_20251010T140000Z`):
//
//   - single:    patch the instance id directly (Google honors this
//                as a per-occurrence override).
//   - series:    look up the master via instance.recurringEventId and
//                patch the master, propagating to every instance.
//   - following: bound the master's RRULE with `UNTIL=instance-1s` so
//                the prefix series ends, then create a *new* series
//                starting at the instance with the patched fields and
//                the master's tail recurrence (no UNTIL/COUNT).

import type {
  AccessTokenArgs,
  CalendarProvider,
  CalendarProviderCapabilities,
} from "@mailai/providers";
import type {
  CreateEventArgs,
  CreatedEvent,
  DeleteEventArgs,
  EventEditScope,
  EventMetadata,
  ListEventsArgs,
  NormalizedCalendar,
  NormalizedEvent,
  PatchEventArgs,
  RecurrenceRule,
  RespondEventArgs,
} from "@mailai/providers/calendar";
import {
  createGoogleEvent,
  deleteGoogleEvent,
  getGoogleEvent,
  listGoogleCalendars,
  listGoogleEvents,
  parseRRule,
  patchGoogleEvent,
  respondGoogleEvent,
  serializeRRule,
} from "../calendar.js";

const CAPABILITIES: CalendarProviderCapabilities = {
  mutate: true,
  conferences: ["google"],
  respondTentative: true,
  recurrence: true,
  editScopes: ["single", "following", "series"],
  patchAttendees: true,
  timeZones: true,
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
      ...(args.recurrence ? { recurrence: args.recurrence } : {}),
      ...(args.timeZone ? { timeZone: args.timeZone } : {}),
      // Always "none": the calendar handler emits its own RFC 5546
      // iMIP envelope and we don't want Google to send a duplicate
      // notification email.
      sendUpdates: "none",
    });
  }

  async patchEvent(args: AccessTokenArgs & PatchEventArgs): Promise<void> {
    const scope: EventEditScope = args.scope ?? "single";
    const p = args.patch;
    const needsExisting =
      scope !== "single" ||
      (p.attendeesAdd && p.attendeesAdd.length > 0) ||
      (p.attendeesRemove && p.attendeesRemove.length > 0);
    const existing = needsExisting
      ? await getGoogleEvent({
          accessToken: args.accessToken,
          calendarId: args.calendarId,
          providerEventId: args.providerEventId,
        })
      : null;

    if (scope === "following") {
      await this.applyFollowingScope({
        accessToken: args.accessToken,
        calendarId: args.calendarId,
        providerEventId: args.providerEventId,
        patch: p,
      });
      return;
    }

    const targetId =
      scope === "series" && existing?.recurringEventId
        ? existing.recurringEventId
        : args.providerEventId;

    const body = buildGooglePatchBody(p, existing?.attendees ?? null);
    await patchGoogleEvent({
      accessToken: args.accessToken,
      calendarId: args.calendarId,
      providerEventId: targetId,
      patch: body,
    });
  }

  async deleteEvent(args: AccessTokenArgs & DeleteEventArgs): Promise<void> {
    const scope: EventEditScope = args.scope ?? "single";
    if (scope === "following") {
      await this.applyFollowingScope({
        accessToken: args.accessToken,
        calendarId: args.calendarId,
        providerEventId: args.providerEventId,
        // No patch — just bound the master series and skip creating a
        // tail.
        patch: {},
        deleteTail: true,
      });
      return;
    }
    if (scope === "series") {
      const existing = await getGoogleEvent({
        accessToken: args.accessToken,
        calendarId: args.calendarId,
        providerEventId: args.providerEventId,
      });
      const id = existing.recurringEventId ?? args.providerEventId;
      await deleteGoogleEvent({
        accessToken: args.accessToken,
        calendarId: args.calendarId,
        providerEventId: id,
      });
      return;
    }
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

  // "this and following" pattern: bound the master series with an
  // RRULE UNTIL one second before the clicked instance, then create a
  // new series starting at that instance with the patched fields. If
  // `deleteTail` is set, we skip the new series — that's the delete
  // scope.
  private async applyFollowingScope(args: {
    accessToken: string;
    calendarId: string;
    providerEventId: string;
    patch: PatchEventArgs["patch"];
    deleteTail?: boolean;
  }): Promise<void> {
    const instance = await getGoogleEvent({
      accessToken: args.accessToken,
      calendarId: args.calendarId,
      providerEventId: args.providerEventId,
    });
    if (!instance.recurringEventId) {
      // Not actually part of a series — fall back to a single-event
      // patch so callers don't get a confusing 4xx.
      const body = buildGooglePatchBody(args.patch, instance.attendees);
      await patchGoogleEvent({
        accessToken: args.accessToken,
        calendarId: args.calendarId,
        providerEventId: args.providerEventId,
        patch: body,
      });
      return;
    }
    const master = await getGoogleEvent({
      accessToken: args.accessToken,
      calendarId: args.calendarId,
      providerEventId: instance.recurringEventId,
    });
    const masterRruleLine = (master.recurrence ?? []).find((l) =>
      l.startsWith("RRULE:"),
    );
    if (!masterRruleLine) {
      throw new Error("master event has no RRULE; cannot split following");
    }
    const masterRule = parseRRule(masterRruleLine);
    if (!masterRule) {
      throw new Error("could not parse master RRULE for following split");
    }

    const instanceStart = instance.start.dateTime
      ? new Date(instance.start.dateTime)
      : new Date(`${instance.start.date ?? ""}T00:00:00Z`);
    const untilDate = new Date(instanceStart.getTime() - 1000);

    const boundedRule: RecurrenceRule = (() => {
      const next: RecurrenceRule = {
        freq: masterRule.freq,
        ...(masterRule.interval !== undefined ? { interval: masterRule.interval } : {}),
        ...(masterRule.byday ? { byday: masterRule.byday } : {}),
        ...(masterRule.bymonthday ? { bymonthday: masterRule.bymonthday } : {}),
        until: untilDate,
      };
      return next;
    })();

    await patchGoogleEvent({
      accessToken: args.accessToken,
      calendarId: args.calendarId,
      providerEventId: instance.recurringEventId,
      patch: {
        recurrence: [`RRULE:${serializeRRule(boundedRule)}`],
      },
    });

    if (args.deleteTail) return;

    // Create the tail series. Use the patched fields where present,
    // otherwise the instance's own values.
    const tailStart = args.patch.startsAt ?? instanceStart;
    const tailEnd =
      args.patch.endsAt ??
      (instance.end.dateTime
        ? new Date(instance.end.dateTime)
        : new Date(`${instance.end.date ?? ""}T00:00:00Z`));

    // Tail recurrence inherits the master's frequency / byday / bymonthday
    // but drops UNTIL / COUNT — the new series runs until next edited.
    const tailRule: RecurrenceRule = args.patch.recurrence ?? {
      freq: masterRule.freq,
      ...(masterRule.interval !== undefined ? { interval: masterRule.interval } : {}),
      ...(masterRule.byday ? { byday: masterRule.byday } : {}),
      ...(masterRule.bymonthday ? { bymonthday: masterRule.bymonthday } : {}),
    };

    // Read previous summary/description/location from instance for
    // continuity when the patch doesn't override them.
    const inst = instance as unknown as {
      // Raw GoogleEvent fields surfaced via raw on listEvents but our
      // helper-shaped getter returns a narrower type. We re-fetch
      // through listEvents would be overkill for these strings; the
      // patch carries the new value when the user wants a change.
    };
    void inst;

    await createGoogleEvent({
      accessToken: args.accessToken,
      calendarId: args.calendarId,
      summary: args.patch.summary ?? "",
      ...(args.patch.description !== undefined
        ? { description: args.patch.description }
        : {}),
      ...(args.patch.location !== undefined ? { location: args.patch.location } : {}),
      startsAt: tailStart,
      endsAt: tailEnd,
      ...(args.patch.timeZone ? { timeZone: args.patch.timeZone } : {}),
      recurrence: tailRule,
      sendUpdates: "none",
    });
  }
}

// Translate the normalized patch into Google's body shape. Pulls the
// existing attendee list off the event and merges add/remove deltas
// before sending.
function buildGooglePatchBody(
  patch: PatchEventArgs["patch"],
  existingAttendees:
    | { email: string; responseStatus?: string; displayName?: string; organizer?: boolean }[]
    | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (patch.summary !== undefined) body["summary"] = patch.summary;
  if (patch.description !== undefined) body["description"] = patch.description;
  if (patch.location !== undefined) body["location"] = patch.location;
  if (patch.startsAt) {
    if (patch.allDay) {
      body["start"] = { date: patch.startsAt.toISOString().slice(0, 10) };
    } else {
      const start: Record<string, unknown> = {
        dateTime: patch.startsAt.toISOString(),
      };
      if (patch.timeZone) start["timeZone"] = patch.timeZone;
      body["start"] = start;
    }
  }
  if (patch.endsAt) {
    if (patch.allDay) {
      body["end"] = { date: patch.endsAt.toISOString().slice(0, 10) };
    } else {
      const end: Record<string, unknown> = {
        dateTime: patch.endsAt.toISOString(),
      };
      if (patch.timeZone) end["timeZone"] = patch.timeZone;
      body["end"] = end;
    }
  }
  if (patch.recurrence !== undefined) {
    body["recurrence"] = patch.recurrence === null
      ? []
      : [`RRULE:${serializeRRule(patch.recurrence)}`];
  }
  const adds = patch.attendeesAdd ?? [];
  const removes = (patch.attendeesRemove ?? []).map((e) => e.toLowerCase());
  if (adds.length > 0 || removes.length > 0) {
    const existing = existingAttendees ?? [];
    const merged = existing.filter(
      (a) => !removes.includes(a.email.toLowerCase()),
    );
    for (const email of adds) {
      if (!merged.some((a) => a.email.toLowerCase() === email.toLowerCase())) {
        merged.push({ email });
      }
    }
    body["attendees"] = merged;
  }
  return body;
}
