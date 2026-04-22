// CommandBus handlers for calendar:create-event / update-event /
// delete-event / respond.
//
// All write paths go provider-side first (Google Calendar / Microsoft
// Graph) and then mirror the result into our local `events` table so
// the calendar grid stays in sync without waiting for the next poll.

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
  type Pool,
} from "@mailai/overlay-db";
import {
  createGoogleEvent,
  createGraphEvent,
  deleteGoogleEvent,
  deleteGraphEvent,
  getValidAccessToken,
  patchGoogleEvent,
  patchGraphEvent,
  respondGoogleEvent,
  respondGraphEvent,
  type ProviderCredentials,
} from "@mailai/oauth-tokens";

export interface CalendarHandlerDeps {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly credentials: ProviderCredentials;
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
}

interface UpdateEventPayload {
  eventId: string;
  summary?: string;
  description?: string;
  location?: string;
  startsAt?: string;
  endsAt?: string;
}

interface DeleteEventPayload {
  eventId: string;
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
    let providerEventId: string;
    if (ctx.account.provider === "google-mail") {
      const r = await createGoogleEvent({
        accessToken: ctx.accessToken,
        calendarId: ctx.calendar.providerCalendarId,
        summary: cmd.payload.summary,
        ...(cmd.payload.description ? { description: cmd.payload.description } : {}),
        ...(cmd.payload.location ? { location: cmd.payload.location } : {}),
        startsAt,
        endsAt,
        ...(cmd.payload.allDay !== undefined ? { allDay: cmd.payload.allDay } : {}),
        ...(cmd.payload.attendees ? { attendees: cmd.payload.attendees } : {}),
      });
      providerEventId = r.providerEventId;
    } else if (ctx.account.provider === "outlook") {
      const r = await createGraphEvent({
        accessToken: ctx.accessToken,
        calendarId: ctx.calendar.providerCalendarId,
        summary: cmd.payload.summary,
        ...(cmd.payload.description ? { description: cmd.payload.description } : {}),
        ...(cmd.payload.location ? { location: cmd.payload.location } : {}),
        startsAt,
        endsAt,
        ...(cmd.payload.attendees ? { attendees: cmd.payload.attendees } : {}),
      });
      providerEventId = r.providerEventId;
    } else {
      throw new MailaiError("validation_error", `unsupported provider ${ctx.account.provider}`);
    }
    const localId = `evt_${randomUUID()}`;
    await withTenant(deps.pool, deps.tenantId, async (tx) => {
      const repo = new CalendarRepository(tx);
      await repo.upsertEvent({
        id: localId,
        tenantId: deps.tenantId,
        calendarId: cmd.payload.calendarId,
        providerEventId,
        summary: cmd.payload.summary,
        ...(cmd.payload.description ? { description: cmd.payload.description } : {}),
        ...(cmd.payload.location ? { location: cmd.payload.location } : {}),
        startsAt,
        endsAt,
        ...(cmd.payload.allDay !== undefined ? { allDay: cmd.payload.allDay } : {}),
        attendees: (cmd.payload.attendees ?? []).map((email) => ({ email })),
      });
    });
    return wrap(localId, /*before*/ null, {
      summary: cmd.payload.summary,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
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
    const patch: Record<string, unknown> = {};
    if (cmd.payload.summary !== undefined) patch["summary"] = cmd.payload.summary;
    if (cmd.payload.description !== undefined) patch["description"] = cmd.payload.description;
    if (cmd.payload.location !== undefined) patch["location"] = cmd.payload.location;
    if (cmd.payload.startsAt) {
      patch["start"] = { dateTime: new Date(cmd.payload.startsAt).toISOString() };
    }
    if (cmd.payload.endsAt) {
      patch["end"] = { dateTime: new Date(cmd.payload.endsAt).toISOString() };
    }
    if (ctx.account.provider === "google-mail") {
      await patchGoogleEvent({
        accessToken: ctx.accessToken,
        calendarId: ctx.calendar.providerCalendarId,
        providerEventId: event.providerEventId,
        patch,
      });
    } else if (ctx.account.provider === "outlook") {
      // Graph uses different field names than Google's PATCH; map a
      // small subset here.
      const graphPatch: Record<string, unknown> = {};
      if (cmd.payload.summary !== undefined) graphPatch["subject"] = cmd.payload.summary;
      if (cmd.payload.description !== undefined) {
        graphPatch["body"] = { contentType: "text", content: cmd.payload.description };
      }
      if (cmd.payload.location !== undefined) {
        graphPatch["location"] = { displayName: cmd.payload.location };
      }
      if (cmd.payload.startsAt) {
        graphPatch["start"] = {
          dateTime: new Date(cmd.payload.startsAt).toISOString(),
          timeZone: "UTC",
        };
      }
      if (cmd.payload.endsAt) {
        graphPatch["end"] = {
          dateTime: new Date(cmd.payload.endsAt).toISOString(),
          timeZone: "UTC",
        };
      }
      await patchGraphEvent({
        accessToken: ctx.accessToken,
        providerEventId: event.providerEventId,
        patch: graphPatch,
      });
    }
    await withTenant(deps.pool, deps.tenantId, async (tx) => {
      const repo = new CalendarRepository(tx);
      await repo.upsertEvent({
        id: event.id,
        tenantId: deps.tenantId,
        calendarId: event.calendarId,
        providerEventId: event.providerEventId,
        ...(event.icalUid ? { icalUid: event.icalUid } : {}),
        summary: cmd.payload.summary ?? event.summary,
        description: cmd.payload.description ?? event.description,
        location: cmd.payload.location ?? event.location,
        startsAt: cmd.payload.startsAt ? new Date(cmd.payload.startsAt) : event.startsAt,
        endsAt: cmd.payload.endsAt ? new Date(cmd.payload.endsAt) : event.endsAt,
        allDay: event.allDay,
        attendees: event.attendeesJson,
        ...(event.organizerEmail ? { organizerEmail: event.organizerEmail } : {}),
      });
    });
    return wrap(
      event.id,
      { summary: event.summary, startsAt: event.startsAt.toISOString(), endsAt: event.endsAt.toISOString() },
      {
        summary: cmd.payload.summary ?? event.summary,
        startsAt: (cmd.payload.startsAt ?? event.startsAt.toISOString()),
        endsAt: (cmd.payload.endsAt ?? event.endsAt.toISOString()),
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
    if (ctx.account.provider === "google-mail") {
      await deleteGoogleEvent({
        accessToken: ctx.accessToken,
        calendarId: ctx.calendar.providerCalendarId,
        providerEventId: event.providerEventId,
      });
    } else if (ctx.account.provider === "outlook") {
      await deleteGraphEvent({
        accessToken: ctx.accessToken,
        providerEventId: event.providerEventId,
      });
    }
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
    if (ctx.account.provider === "google-mail") {
      await respondGoogleEvent({
        accessToken: ctx.accessToken,
        calendarId: ctx.calendar.providerCalendarId,
        providerEventId: event.providerEventId,
        attendeeEmail: ctx.account.email,
        response: cmd.payload.response,
      });
    } else if (ctx.account.provider === "outlook") {
      await respondGraphEvent({
        accessToken: ctx.accessToken,
        providerEventId: event.providerEventId,
        response: cmd.payload.response,
        ...(cmd.payload.comment ? { comment: cmd.payload.comment } : {}),
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
  readonly account: { id: string; email: string; provider: string };
  readonly calendar: { id: string; providerCalendarId: string };
  readonly accessToken: string;
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
    return {
      account: { id: account.id, email: account.email, provider: account.provider },
      calendar: {
        id: calendar.id,
        providerCalendarId: calendar.providerCalendarId,
      },
      accessToken,
    };
  });
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
