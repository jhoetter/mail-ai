// CommandBus handlers for calendar:create-event / update-event /
// delete-event / respond.
//
// All write paths go provider-side first (Google Calendar / Microsoft
// Graph) and then mirror the result into our local `events` table so
// the calendar grid stays in sync without waiting for the next poll.
//
// In addition we always emit an RFC 5545 (iCalendar) + RFC 5546 (iTIP)
// invite over our own SMTP path (sendGmail / sendGraphRawMime) so the
// wire format is uniform across providers and Apple Mail / Thunderbird
// users receive a real meeting card. To avoid duplicate notifications
// we ask Google not to email attendees (`sendUpdates=none`); Graph
// doesn't email on plain create, so it needs no equivalent flag.

import type {
  CommandHandler,
  EntitySnapshot,
  HandlerResult,
} from "@mailai/core";
import { MailaiError } from "@mailai/core";
import { randomUUID } from "node:crypto";
import {
  CalendarRepository,
  OauthAccountsRepository,
  withTenant,
  type EventMeetingProvider,
  type Pool,
} from "@mailai/overlay-db";
import {
  composeIcs,
  composeMessage,
  type IcsAttendee,
  type IcsConference,
  type IcsEvent,
  type IcsMethod,
  type IcsPartstat,
} from "@mailai/mime";
import {
  getValidAccessToken,
  type ProviderCredentials,
} from "@mailai/oauth-tokens";
import type {
  CalendarProvider,
  CalendarProviderRegistry,
  MailProviderRegistry,
} from "@mailai/providers";
import type {
  EventEditScope,
  NormalizedEventPatch,
  RecurrenceRule,
} from "@mailai/providers/calendar";

export interface CalendarHandlerDeps {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly credentials: ProviderCredentials;
  readonly calendarProviders: CalendarProviderRegistry;
  // The iTIP envelope is delivered over the mail surface, so the
  // calendar handler also needs the MailProviderRegistry to fan out
  // REQUEST / REPLY / CANCEL.
  readonly mailProviders: MailProviderRegistry;
}

// 'gmeet' / 'teams' force a provider-side conference; 'none' skips it.
// Keep the strings short because they round-trip through the agent
// schema (packages/agent/src/schemas.ts) and the UI dropdown.
type MeetingChoice = "gmeet" | "teams" | "none";

// Wire-shaped RRULE — the agent schema validates this. We accept
// `until` as an ISO string and convert to Date inside the handler.
interface RecurrenceRulePayload {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval?: number;
  count?: number;
  until?: string;
  byday?: ReadonlyArray<"MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU">;
  bymonthday?: ReadonlyArray<number>;
}

interface CreateEventPayload {
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
  recurrence?: RecurrenceRulePayload;
}

interface UpdateEventPayload {
  eventId: string;
  summary?: string;
  description?: string;
  location?: string;
  startsAt?: string;
  endsAt?: string;
  allDay?: boolean;
  attendeesAdd?: string[];
  attendeesRemove?: string[];
  meeting?: MeetingChoice;
  recurrence?: RecurrenceRulePayload | null;
  timeZone?: string;
  scope?: EventEditScope;
}

interface DeleteEventPayload {
  eventId: string;
  scope?: EventEditScope;
}

interface RespondPayload {
  icalUid?: string;
  eventId?: string;
  response: "accepted" | "declined" | "tentative";
  comment?: string;
}

export function buildCalendarCreateEventHandler(
  deps: CalendarHandlerDeps,
): CommandHandler<"calendar:create-event", CreateEventPayload> {
  return async (cmd) => {
    const ctx = await loadCalendar(deps, cmd.payload.calendarId);
    const startsAt = new Date(cmd.payload.startsAt);
    const endsAt = new Date(cmd.payload.endsAt);
    const meeting: MeetingChoice = cmd.payload.meeting ?? "none";
    assertMeetingCompatible(meeting, ctx.account.provider, ctx.calendarAdapter);
    const attendees = cmd.payload.attendees ?? [];

    const recurrence = cmd.payload.recurrence
      ? toRecurrenceRule(cmd.payload.recurrence)
      : undefined;
    if (recurrence && !ctx.calendarAdapter.capabilities.recurrence) {
      throw new MailaiError(
        "validation_error",
        `provider ${ctx.account.provider} does not support recurrence`,
      );
    }
    if (cmd.payload.timeZone && !ctx.calendarAdapter.capabilities.timeZones) {
      throw new MailaiError(
        "validation_error",
        `provider ${ctx.account.provider} does not support time zones on events`,
      );
    }
    const created = await ctx.calendarAdapter.createEvent({
      accessToken: ctx.accessToken,
      calendarId: ctx.calendar.providerCalendarId,
      summary: cmd.payload.summary,
      ...(cmd.payload.description !== undefined
        ? { description: cmd.payload.description }
        : {}),
      ...(cmd.payload.location !== undefined ? { location: cmd.payload.location } : {}),
      startsAt,
      endsAt,
      ...(cmd.payload.allDay !== undefined ? { allDay: cmd.payload.allDay } : {}),
      ...(attendees.length > 0 ? { attendees } : {}),
      conference: meetingChoiceToConference(meeting),
      ...(cmd.payload.timeZone ? { timeZone: cmd.payload.timeZone } : {}),
      ...(recurrence ? { recurrence } : {}),
    });
    const providerEventId = created.providerEventId;
    const icalUid = created.icalUid;
    const joinUrl: string | null = created.joinUrl;
    const sequence = created.sequence;

    const meetingProvider: EventMeetingProvider | null =
      meeting === "gmeet" ? "google-meet" : meeting === "teams" ? "ms-teams" : null;
    const localId = `evt_${randomUUID()}`;

    await withTenant(deps.pool, deps.tenantId, async (tx) => {
      const repo = new CalendarRepository(tx);
      await repo.upsertEvent({
        id: localId,
        tenantId: deps.tenantId,
        calendarId: cmd.payload.calendarId,
        providerEventId,
        icalUid,
        summary: cmd.payload.summary,
        ...(cmd.payload.description ? { description: cmd.payload.description } : {}),
        ...(cmd.payload.location ? { location: cmd.payload.location } : {}),
        startsAt,
        endsAt,
        ...(cmd.payload.allDay !== undefined ? { allDay: cmd.payload.allDay } : {}),
        attendees: attendees.map((email) => ({ email })),
        organizerEmail: ctx.account.email,
        sequence,
        meetingProvider,
        meetingJoinUrl: joinUrl,
      });
    });

    if (attendees.length > 0) {
      await sendInvite({
        deps,
        ctx,
        method: "REQUEST",
        icalUid,
        sequence,
        startsAt,
        endsAt,
        allDay: cmd.payload.allDay === true,
        summary: cmd.payload.summary,
        ...(cmd.payload.description ? { description: cmd.payload.description } : {}),
        ...(cmd.payload.location ? { location: cmd.payload.location } : {}),
        attendees: attendees.map((email) => ({ email })),
        meetingProvider,
        joinUrl,
      });
    }

    return wrap(localId, /*before*/ null, {
      summary: cmd.payload.summary,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      meetingProvider,
      meetingJoinUrl: joinUrl,
    });
  };
}

export function buildCalendarUpdateEventHandler(
  deps: CalendarHandlerDeps,
): CommandHandler<"calendar:update-event", UpdateEventPayload> {
  return async (cmd) => {
    const event = await withTenant(deps.pool, deps.tenantId, (tx) =>
      new CalendarRepository(tx).byId(deps.tenantId, cmd.payload.eventId),
    );
    if (!event) {
      throw new MailaiError("not_found", `event ${cmd.payload.eventId} not found`);
    }
    const ctx = await loadCalendar(deps, event.calendarId);
    const scope = cmd.payload.scope;
    if (scope && !ctx.calendarAdapter.capabilities.editScopes.includes(scope)) {
      throw new MailaiError(
        "validation_error",
        `provider ${ctx.account.provider} does not support edit scope ${scope}`,
      );
    }
    if (
      ((cmd.payload.attendeesAdd && cmd.payload.attendeesAdd.length > 0) ||
        (cmd.payload.attendeesRemove && cmd.payload.attendeesRemove.length > 0)) &&
      !ctx.calendarAdapter.capabilities.patchAttendees
    ) {
      throw new MailaiError(
        "validation_error",
        `provider ${ctx.account.provider} does not support attendee patches`,
      );
    }
    if (
      cmd.payload.recurrence !== undefined &&
      !ctx.calendarAdapter.capabilities.recurrence
    ) {
      throw new MailaiError(
        "validation_error",
        `provider ${ctx.account.provider} does not support recurrence patches`,
      );
    }
    if (cmd.payload.timeZone && !ctx.calendarAdapter.capabilities.timeZones) {
      throw new MailaiError(
        "validation_error",
        `provider ${ctx.account.provider} does not support time zones on events`,
      );
    }
    // Build a normalized patch — every set field flows into a
    // provider-shaped body inside the adapter so this handler stays
    // free of provider branching.
    const recurrencePatch =
      cmd.payload.recurrence === undefined
        ? undefined
        : cmd.payload.recurrence === null
          ? null
          : toRecurrenceRule(cmd.payload.recurrence);
    const patch: NormalizedEventPatch = {
      ...(cmd.payload.summary !== undefined ? { summary: cmd.payload.summary } : {}),
      ...(cmd.payload.description !== undefined ? { description: cmd.payload.description } : {}),
      ...(cmd.payload.location !== undefined ? { location: cmd.payload.location } : {}),
      ...(cmd.payload.startsAt ? { startsAt: new Date(cmd.payload.startsAt) } : {}),
      ...(cmd.payload.endsAt ? { endsAt: new Date(cmd.payload.endsAt) } : {}),
      ...(cmd.payload.allDay !== undefined ? { allDay: cmd.payload.allDay } : {}),
      ...(cmd.payload.attendeesAdd && cmd.payload.attendeesAdd.length > 0
        ? { attendeesAdd: cmd.payload.attendeesAdd }
        : {}),
      ...(cmd.payload.attendeesRemove && cmd.payload.attendeesRemove.length > 0
        ? { attendeesRemove: cmd.payload.attendeesRemove }
        : {}),
      ...(recurrencePatch !== undefined ? { recurrence: recurrencePatch } : {}),
      ...(cmd.payload.timeZone ? { timeZone: cmd.payload.timeZone } : {}),
    };
    await ctx.calendarAdapter.patchEvent({
      accessToken: ctx.accessToken,
      calendarId: ctx.calendar.providerCalendarId,
      providerEventId: event.providerEventId,
      patch,
      ...(scope ? { scope } : {}),
    });

    const startsAt = cmd.payload.startsAt ? new Date(cmd.payload.startsAt) : event.startsAt;
    const endsAt = cmd.payload.endsAt ? new Date(cmd.payload.endsAt) : event.endsAt;
    const summary = cmd.payload.summary ?? event.summary ?? "";
    const description = cmd.payload.description ?? event.description ?? undefined;
    const location = cmd.payload.location ?? event.location ?? undefined;
    const attendees = (event.attendeesJson ?? []).map((a) => ({
      email: a.email,
      ...(a.name ? { name: a.name } : {}),
    }));

    const newSequence = await withTenant(deps.pool, deps.tenantId, async (tx) => {
      const repo = new CalendarRepository(tx);
      const seq = await repo.bumpSequence(deps.tenantId, event.id);
      await repo.upsertEvent({
        id: event.id,
        tenantId: deps.tenantId,
        calendarId: event.calendarId,
        providerEventId: event.providerEventId,
        ...(event.icalUid ? { icalUid: event.icalUid } : {}),
        summary,
        description: description ?? null,
        location: location ?? null,
        startsAt,
        endsAt,
        allDay: event.allDay,
        attendees: event.attendeesJson,
        ...(event.organizerEmail ? { organizerEmail: event.organizerEmail } : {}),
        sequence: seq,
        meetingProvider: event.meetingProvider,
        meetingJoinUrl: event.meetingJoinUrl,
      });
      return seq;
    });

    if (event.icalUid && attendees.length > 0) {
      await sendInvite({
        deps,
        ctx,
        method: "REQUEST",
        icalUid: event.icalUid,
        sequence: newSequence,
        startsAt,
        endsAt,
        allDay: event.allDay,
        summary,
        ...(description ? { description } : {}),
        ...(location ? { location } : {}),
        attendees,
        meetingProvider: event.meetingProvider,
        joinUrl: event.meetingJoinUrl,
      });
    }

    return wrap(
      event.id,
      {
        summary: event.summary,
        startsAt: event.startsAt.toISOString(),
        endsAt: event.endsAt.toISOString(),
      },
      {
        summary,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
      },
    );
  };
}

export function buildCalendarDeleteEventHandler(
  deps: CalendarHandlerDeps,
): CommandHandler<"calendar:delete-event", DeleteEventPayload> {
  return async (cmd) => {
    const event = await withTenant(deps.pool, deps.tenantId, (tx) =>
      new CalendarRepository(tx).byId(deps.tenantId, cmd.payload.eventId),
    );
    if (!event) {
      throw new MailaiError("not_found", `event ${cmd.payload.eventId} not found`);
    }
    const ctx = await loadCalendar(deps, event.calendarId);
    const attendees = (event.attendeesJson ?? []).map((a) => ({
      email: a.email,
      ...(a.name ? { name: a.name } : {}),
    }));

    // Cancel the meeting in the recipient's calendars first: even if
    // the upstream DELETE later fails (network glitch, 5xx), they'll
    // see a CANCELLED event and won't show up to a deleted slot.
    if (event.icalUid && attendees.length > 0) {
      const seq = await withTenant(deps.pool, deps.tenantId, (tx) =>
        new CalendarRepository(tx).bumpSequence(deps.tenantId, event.id),
      );
      await sendInvite({
        deps,
        ctx,
        method: "CANCEL",
        icalUid: event.icalUid,
        sequence: seq,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        allDay: event.allDay,
        summary: event.summary ?? "",
        ...(event.description ? { description: event.description } : {}),
        ...(event.location ? { location: event.location } : {}),
        attendees,
        meetingProvider: event.meetingProvider,
        joinUrl: event.meetingJoinUrl,
      });
    }

    const deleteScope = cmd.payload.scope;
    if (deleteScope && !ctx.calendarAdapter.capabilities.editScopes.includes(deleteScope)) {
      throw new MailaiError(
        "validation_error",
        `provider ${ctx.account.provider} does not support delete scope ${deleteScope}`,
      );
    }
    await ctx.calendarAdapter.deleteEvent({
      accessToken: ctx.accessToken,
      calendarId: ctx.calendar.providerCalendarId,
      providerEventId: event.providerEventId,
      ...(deleteScope ? { scope: deleteScope } : {}),
    });
    await withTenant(deps.pool, deps.tenantId, (tx) =>
      new CalendarRepository(tx).deleteEvent(deps.tenantId, event.id),
    );
    return wrap(event.id, { summary: event.summary }, null);
  };
}

export function buildCalendarRespondHandler(
  deps: CalendarHandlerDeps,
): CommandHandler<"calendar:respond", RespondPayload> {
  return async (cmd) => {
    const event = await withTenant(deps.pool, deps.tenantId, async (tx) => {
      const repo = new CalendarRepository(tx);
      if (cmd.payload.eventId) return repo.byId(deps.tenantId, cmd.payload.eventId);
      if (cmd.payload.icalUid) return repo.byIcalUid(deps.tenantId, cmd.payload.icalUid);
      return null;
    });
    if (!event) {
      throw new MailaiError(
        "not_found",
        `event not found by ${cmd.payload.eventId ? "id" : "icalUid"}`,
      );
    }
    const ctx = await loadCalendar(deps, event.calendarId);

    await ctx.calendarAdapter.respondEvent({
      accessToken: ctx.accessToken,
      calendarId: ctx.calendar.providerCalendarId,
      providerEventId: event.providerEventId,
      attendeeEmail: ctx.account.email,
      response: cmd.payload.response,
      ...(cmd.payload.comment ? { comment: cmd.payload.comment } : {}),
    });

    // Send the iTIP REPLY back to the organizer over SMTP. We
    // deliberately do NOT bump SEQUENCE here — RFC 5546 §3.2.3 says
    // REPLY carries the sequence of the *event being replied to*, not
    // a new one minted by the responder.
    if (event.icalUid && event.organizerEmail) {
      const partstat: IcsPartstat =
        cmd.payload.response === "accepted"
          ? "ACCEPTED"
          : cmd.payload.response === "declined"
            ? "DECLINED"
            : "TENTATIVE";
      await sendInvite({
        deps,
        ctx,
        method: "REPLY",
        icalUid: event.icalUid,
        sequence: event.sequence,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        allDay: event.allDay,
        summary: event.summary ?? "",
        ...(event.location ? { location: event.location } : {}),
        organizerOverride: { email: event.organizerEmail },
        attendees: [
          {
            email: ctx.account.email,
            partstat,
          },
        ],
        // REPLY goes to the organizer only.
        recipientsOverride: [event.organizerEmail],
        meetingProvider: event.meetingProvider,
        joinUrl: event.meetingJoinUrl,
      });
    }

    return wrap(
      event.id,
      { responseStatus: event.responseStatus },
      { responseStatus: cmd.payload.response },
    );
  };
}

interface CalendarContext {
  readonly account: {
    id: string;
    email: string;
    provider: "google-mail" | "outlook";
  };
  readonly calendar: { id: string; providerCalendarId: string };
  readonly accessToken: string;
  // Pre-resolved adapter so handlers don't have to look it up on
  // every operation. The MailProviderRegistry counterpart is held on
  // CalendarHandlerDeps because the iTIP fan-out is global, not
  // per-context.
  readonly calendarAdapter: CalendarProvider;
}

async function loadCalendar(
  deps: CalendarHandlerDeps,
  calendarId: string,
): Promise<CalendarContext> {
  return withTenant(deps.pool, deps.tenantId, async (tx) => {
    const calRepo = new CalendarRepository(tx);
    const calendars = await calRepo.listCalendars(deps.tenantId);
    const calendar = calendars.find((c) => c.id === calendarId);
    if (!calendar) {
      throw new MailaiError("not_found", `calendar ${calendarId} not found`);
    }
    const accountsRepo = new OauthAccountsRepository(tx);
    const account = await accountsRepo.byId(deps.tenantId, calendar.oauthAccountId);
    if (!account) {
      throw new MailaiError(
        "not_found",
        `oauth account ${calendar.oauthAccountId} not found`,
      );
    }
    const accessToken = await getValidAccessToken(account, {
      tenantId: deps.tenantId,
      accounts: accountsRepo,
      credentials: deps.credentials,
    });
    const adapter = deps.calendarProviders.for(account.provider);
    if (!adapter) {
      throw new MailaiError(
        "validation_error",
        `no calendar adapter registered for provider ${account.provider}`,
      );
    }
    return {
      account: { id: account.id, email: account.email, provider: account.provider },
      calendar: {
        id: calendar.id,
        providerCalendarId: calendar.providerCalendarId,
      },
      accessToken,
      calendarAdapter: adapter,
    };
  });
}

// Translate the wire-shaped recurrence (with `until` as ISO string)
// into the port shape the adapter expects (with a Date).
function toRecurrenceRule(payload: RecurrenceRulePayload): RecurrenceRule {
  return {
    freq: payload.freq,
    ...(payload.interval !== undefined ? { interval: payload.interval } : {}),
    ...(payload.count !== undefined ? { count: payload.count } : {}),
    ...(payload.until ? { until: new Date(payload.until) } : {}),
    ...(payload.byday && payload.byday.length > 0 ? { byday: payload.byday } : {}),
    ...(payload.bymonthday && payload.bymonthday.length > 0
      ? { bymonthday: payload.bymonthday }
      : {}),
  };
}

// Map the UI-facing meeting choice onto the CalendarProvider's
// `conference` shape. Kept narrow + total so a new MeetingChoice
// variant becomes a TypeScript error here.
function meetingChoiceToConference(
  meeting: MeetingChoice,
): "google" | "microsoft" | null {
  switch (meeting) {
    case "gmeet":
      return "google";
    case "teams":
      return "microsoft";
    case "none":
      return null;
    default: {
      const _exhaustive: never = meeting;
      void _exhaustive;
      return null;
    }
  }
}

// Translate the Google-shaped patch we already build into the
// Graph-shaped equivalent. Kept tight so the only thing the calendar
// handler has to know about Graph's quirks is the field renames.
// `gmeet` only makes sense on adapters that advertise the "google"
// conference capability; `teams` only on adapters that advertise
// "microsoft". We read the support set off the adapter so a future
// CalDAV / Fastmail / etc. adapter advertising both (or neither)
// works without touching this function.
function assertMeetingCompatible(
  meeting: MeetingChoice,
  provider: "google-mail" | "outlook",
  adapter: CalendarProvider,
): void {
  void provider;
  switch (meeting) {
    case "gmeet":
      if (!adapter.capabilities.conferences.includes("google")) {
        throw new MailaiError(
          "validation_error",
          "google-meet requires a calendar adapter that supports Google Meet",
        );
      }
      return;
    case "teams":
      if (!adapter.capabilities.conferences.includes("microsoft")) {
        throw new MailaiError(
          "validation_error",
          "ms-teams requires a calendar adapter that supports Microsoft Teams",
        );
      }
      return;
    case "none":
      return;
    default: {
      const _exhaustive: never = meeting;
      void _exhaustive;
    }
  }
}

interface SendInviteArgs {
  readonly deps: CalendarHandlerDeps;
  readonly ctx: CalendarContext;
  readonly method: IcsMethod;
  readonly icalUid: string;
  readonly sequence: number;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly allDay: boolean;
  readonly summary: string;
  readonly description?: string;
  readonly location?: string;
  readonly attendees: readonly IcsAttendee[];
  readonly organizerOverride?: { readonly email: string; readonly name?: string };
  readonly recipientsOverride?: readonly string[];
  readonly meetingProvider: EventMeetingProvider | null;
  readonly joinUrl: string | null;
}

async function sendInvite(args: SendInviteArgs): Promise<void> {
  const conference: IcsConference | undefined =
    args.meetingProvider && args.joinUrl
      ? { provider: args.meetingProvider, joinUrl: args.joinUrl }
      : undefined;

  const icsEvent: IcsEvent = {
    uid: args.icalUid,
    sequence: args.sequence,
    dtstamp: new Date(),
    dtstart: args.startsAt,
    dtend: args.endsAt,
    allDay: args.allDay,
    summary: args.summary,
    ...(args.description ? { description: args.description } : {}),
    ...(args.location ? { location: args.location } : {}),
    ...(args.joinUrl ? { url: args.joinUrl } : {}),
    organizer: args.organizerOverride ?? { email: args.ctx.account.email },
    attendees: args.attendees,
    ...(conference ? { conference } : {}),
  };
  const ics = composeIcs(icsEvent, args.method);

  const recipients = args.recipientsOverride ?? args.attendees.map((a) => a.email);
  if (recipients.length === 0) return;

  const subject = subjectFor(args.method, args.summary);
  const textBody = textBodyFor(args.method, icsEvent, args.joinUrl);

  const composed = composeMessage({
    from: args.ctx.account.email,
    to: recipients,
    subject,
    textBody,
    calendar: { method: args.method, ics: ics.body },
  });

  // Fan out the iTIP envelope through MailProvider.send so we don't
  // have to know the provider's RFC 822 transport. We intentionally
  // skip `mail-send.sendAndSnapshot` because iTIP messages aren't
  // visible in the Sent view — they're system mail.
  const mailAdapter = args.deps.mailProviders.for(args.ctx.account.provider);
  if (!mailAdapter) {
    throw new MailaiError(
      "validation_error",
      `no mail adapter registered for provider ${args.ctx.account.provider}`,
    );
  }
  await mailAdapter.send({
    accessToken: args.ctx.accessToken,
    message: {
      raw: composed.raw,
      // iTIP envelopes carry their own RFC 822 Message-ID inside
      // composeMessage's output; the send result Message-ID is fine
      // to discard since we never persist these.
      rfc822MessageId: `imip-${args.icalUid}`,
    },
  });
}

function subjectFor(method: IcsMethod, summary: string): string {
  switch (method) {
    case "REQUEST":
      return `Invitation: ${summary}`;
    case "CANCEL":
      return `Cancelled: ${summary}`;
    case "REPLY":
      return `Re: ${summary}`;
    default: {
      const _exhaustive: never = method;
      void _exhaustive;
      return summary;
    }
  }
}

function textBodyFor(method: IcsMethod, ev: IcsEvent, joinUrl: string | null): string {
  const when = ev.allDay
    ? `${ev.dtstart.toISOString().slice(0, 10)} (all day)`
    : `${ev.dtstart.toISOString()} – ${ev.dtend.toISOString()}`;
  const lines: string[] = [];
  switch (method) {
    case "REQUEST":
      lines.push(`You're invited to: ${ev.summary}`);
      break;
    case "CANCEL":
      lines.push(`This event has been cancelled: ${ev.summary}`);
      break;
    case "REPLY":
      lines.push(`RSVP for: ${ev.summary}`);
      break;
    default: {
      const _exhaustive: never = method;
      void _exhaustive;
    }
  }
  lines.push(`When: ${when}`);
  if (ev.location) lines.push(`Where: ${ev.location}`);
  if (joinUrl) lines.push(`Join: ${joinUrl}`);
  if (ev.description) {
    lines.push("");
    lines.push(ev.description);
  }
  return lines.join("\n");
}

function wrap(
  id: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): HandlerResult {
  const beforeSnap: EntitySnapshot = {
    kind: "event",
    id,
    version: before ? 1 : 0,
    data: before ?? {},
  };
  const afterSnap: EntitySnapshot = {
    kind: "event",
    id,
    version: after ? 2 : 0,
    data: after ?? {},
  };
  return { before: [beforeSnap], after: [afterSnap], imapSideEffects: [] };
}
