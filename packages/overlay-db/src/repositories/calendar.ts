// Calendars + events repository (read + write).
//
// Modeled after OauthMessagesRepository: idempotent upsertMany keyed
// on the provider's stable id, plus listing helpers for the
// /calendar page and the .ics RSVP card. Provider-side write paths
// (create/update/delete event) live in @mailai/oauth-tokens; this
// repo only persists what we've already heard back from the
// provider, so a desync between our cache and Google/Graph just
// means a missing event until the next sync — never a wrong one.

import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { calendars, events } from "../schema.js";

// Same provider taxonomy as oauth_accounts: a calendar is reachable
// via the same OAuth connection as the corresponding mailbox, so we
// reuse the values rather than inventing a parallel "google-cal".
export type CalendarProvider = "google-mail" | "outlook";

export interface CalendarRow {
  readonly id: string;
  readonly tenantId: string;
  readonly oauthAccountId: string;
  readonly provider: CalendarProvider;
  readonly providerCalendarId: string;
  readonly name: string;
  readonly color: string | null;
  readonly isPrimary: boolean;
  readonly isVisible: boolean;
  readonly fetchedAt: Date;
}

export interface CalendarInsert {
  readonly id: string;
  readonly tenantId: string;
  readonly oauthAccountId: string;
  readonly provider: CalendarProvider;
  readonly providerCalendarId: string;
  readonly name: string;
  readonly color?: string | null;
  readonly isPrimary?: boolean;
  readonly isVisible?: boolean;
}

export interface EventAttendee {
  readonly email: string;
  readonly name?: string;
  readonly response?: "accepted" | "declined" | "tentative" | "needsAction";
  readonly organizer?: boolean;
}

export interface EventRow {
  readonly id: string;
  readonly tenantId: string;
  readonly calendarId: string;
  readonly providerEventId: string;
  readonly icalUid: string | null;
  readonly summary: string | null;
  readonly description: string | null;
  readonly location: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly allDay: boolean;
  readonly attendeesJson: EventAttendee[];
  readonly organizerEmail: string | null;
  readonly responseStatus: string | null;
  readonly status: string | null;
  readonly recurrenceJson: unknown;
  readonly rawJson: unknown;
  readonly fetchedAt: Date;
}

export interface EventInsert {
  readonly id: string;
  readonly tenantId: string;
  readonly calendarId: string;
  readonly providerEventId: string;
  readonly icalUid?: string | null;
  readonly summary?: string | null;
  readonly description?: string | null;
  readonly location?: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly allDay?: boolean;
  readonly attendees?: EventAttendee[];
  readonly organizerEmail?: string | null;
  readonly responseStatus?: string | null;
  readonly status?: string | null;
  readonly rawJson?: unknown;
}

export class CalendarRepository {
  constructor(private readonly db: Database) {}

  async upsertCalendar(row: CalendarInsert): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO calendars (
        id, tenant_id, oauth_account_id, provider, provider_calendar_id,
        name, color, is_primary, is_visible, fetched_at
      ) VALUES (
        ${row.id}, ${row.tenantId}, ${row.oauthAccountId},
        ${row.provider}, ${row.providerCalendarId},
        ${row.name}, ${row.color ?? null},
        ${row.isPrimary ?? false}, ${row.isVisible ?? true}, now()
      )
      ON CONFLICT (oauth_account_id, provider_calendar_id) DO UPDATE SET
        name = EXCLUDED.name,
        color = EXCLUDED.color,
        is_primary = EXCLUDED.is_primary,
        fetched_at = now()
    `);
  }

  async listCalendars(tenantId: string): Promise<CalendarRow[]> {
    const rows = await this.db
      .select()
      .from(calendars)
      .where(eq(calendars.tenantId, tenantId))
      .orderBy(asc(calendars.name));
    return rows as CalendarRow[];
  }

  async upsertEvent(row: EventInsert): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO events (
        id, tenant_id, calendar_id, provider_event_id, ical_uid,
        summary, description, location,
        starts_at, ends_at, all_day,
        attendees_json, organizer_email, response_status, status, raw_json
      ) VALUES (
        ${row.id}, ${row.tenantId}, ${row.calendarId}, ${row.providerEventId},
        ${row.icalUid ?? null},
        ${row.summary ?? null}, ${row.description ?? null}, ${row.location ?? null},
        ${row.startsAt.toISOString()}::timestamptz,
        ${row.endsAt.toISOString()}::timestamptz,
        ${row.allDay ?? false},
        ${JSON.stringify(row.attendees ?? [])}::jsonb,
        ${row.organizerEmail ?? null}, ${row.responseStatus ?? null},
        ${row.status ?? null},
        ${row.rawJson === undefined ? null : JSON.stringify(row.rawJson)}::jsonb
      )
      ON CONFLICT (calendar_id, provider_event_id) DO UPDATE SET
        ical_uid = EXCLUDED.ical_uid,
        summary = EXCLUDED.summary,
        description = EXCLUDED.description,
        location = EXCLUDED.location,
        starts_at = EXCLUDED.starts_at,
        ends_at = EXCLUDED.ends_at,
        all_day = EXCLUDED.all_day,
        attendees_json = EXCLUDED.attendees_json,
        organizer_email = EXCLUDED.organizer_email,
        response_status = EXCLUDED.response_status,
        status = EXCLUDED.status,
        raw_json = EXCLUDED.raw_json,
        fetched_at = now()
    `);
  }

  async listEventsInRange(
    tenantId: string,
    calendarId: string,
    from: Date,
    to: Date,
  ): Promise<EventRow[]> {
    const rows = await this.db
      .select()
      .from(events)
      .where(
        and(
          eq(events.tenantId, tenantId),
          eq(events.calendarId, calendarId),
          gte(events.startsAt, from),
          lte(events.startsAt, to),
        ),
      )
      .orderBy(asc(events.startsAt));
    return rows as EventRow[];
  }

  async byIcalUid(tenantId: string, uid: string): Promise<EventRow | null> {
    const rows = await this.db
      .select()
      .from(events)
      .where(and(eq(events.tenantId, tenantId), eq(events.icalUid, uid)));
    return (rows[0] as EventRow | undefined) ?? null;
  }

  async byId(tenantId: string, id: string): Promise<EventRow | null> {
    const rows = await this.db
      .select()
      .from(events)
      .where(and(eq(events.tenantId, tenantId), eq(events.id, id)));
    return (rows[0] as EventRow | undefined) ?? null;
  }

  async deleteEvent(tenantId: string, id: string): Promise<void> {
    await this.db
      .delete(events)
      .where(and(eq(events.tenantId, tenantId), eq(events.id, id)));
  }
}
