// Calendar list + range read routes. Used by the calendar grid + the
// .ics RSVP card. On a fresh tenant we sync calendars + a 60-day
// window of events on demand so the UI works the moment the user
// connects their account.

import type { FastifyInstance } from "fastify";
import {
  CalendarRepository,
  OauthAccountsRepository,
  withTenant,
  type Pool,
} from "@mailai/overlay-db";
import { getValidAccessToken, type ProviderCredentials } from "@mailai/oauth-tokens";
import type { CalendarProviderRegistry } from "@mailai/providers";

export interface CalendarRoutesDeps {
  readonly pool: Pool;
  readonly identity: (req: { headers: Record<string, unknown> }) => Promise<{
    userId: string;
    tenantId: string;
  }>;
  readonly credentials?: ProviderCredentials;
  // Optional so smoke tests / integration tests can boot the routes
  // without provider wiring; routes that need it return a clear error.
  readonly calendarProviders?: CalendarProviderRegistry;
}

export function registerCalendarRoutes(app: FastifyInstance, deps: CalendarRoutesDeps): void {
  app.get("/api/calendars", async (req) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    return withTenant(deps.pool, ident.tenantId, async (tx) => {
      const repo = new CalendarRepository(tx);
      const list = await repo.listCalendars(ident.tenantId);
      // Surface the calendar adapter's capabilities so the UI can
      // gate Meet/Teams entries (and any future conference type) off
      // the port instead of a hardcoded provider-string check.
      return {
        calendars: list.map((c) => {
          const adapter = deps.calendarProviders?.for(c.provider) ?? null;
          const conferences = adapter ? adapter.capabilities.conferences : [];
          return {
            id: c.id,
            name: c.name,
            color: c.color,
            provider: c.provider,
            isPrimary: c.isPrimary,
            isVisible: c.isVisible,
            capabilities: {
              conferences,
            },
          };
        }),
      };
    });
  });

  // Sync calendars for every connected oauth account. Cheap (one HTTP
  // call per account) and idempotent. The UI calls this once after
  // first OAuth connect and on a "Refresh" click.
  app.post("/api/calendars/sync", async (req) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    if (!deps.credentials) {
      return { synced: 0, skipped: "no provider credentials configured" };
    }
    const credentials = deps.credentials;
    return withTenant(deps.pool, ident.tenantId, async (tx) => {
      const repo = new CalendarRepository(tx);
      const accountsRepo = new OauthAccountsRepository(tx);
      const accounts = await accountsRepo.listByTenant(ident.tenantId);
      let synced = 0;
      for (const account of accounts) {
        try {
          const accessToken = await getValidAccessToken(account, {
            tenantId: ident.tenantId,
            accounts: accountsRepo,
            credentials,
          });
          const adapter = deps.calendarProviders?.for(account.provider) ?? null;
          if (!adapter) continue;
          const cals = await adapter.listCalendars({ accessToken });
          for (const c of cals) {
            await repo.upsertCalendar({
              id: `cal_${account.id}_${stableHash(c.providerCalendarId)}`,
              tenantId: ident.tenantId,
              oauthAccountId: account.id,
              provider: account.provider,
              providerCalendarId: c.providerCalendarId,
              name: c.name,
              color: c.color ?? null,
              isPrimary: c.isPrimary,
            });
            synced += 1;
          }
        } catch (err) {
          // Skip the account on failure; one bad account shouldn't
          // sink the whole sync. Surfaced via the audit log later when
          // we wire calendar sync errors into oauth_accounts.last_sync_error.
          console.warn("[calendar] sync failed for account", { id: account.id, err: String(err) });
        }
      }
      return { synced };
    });
  });

  // Toggle a calendar's visibility (the sidebar checkbox). Pure
  // overlay metadata — no provider call, no token usage.
  app.patch("/api/calendars/:id", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const { id } = req.params as { id: string };
    const body = req.body as { isVisible?: unknown };
    if (typeof body.isVisible !== "boolean") {
      return reply
        .code(400)
        .send({ error: "validation_error", message: "isVisible (boolean) required" });
    }
    return withTenant(deps.pool, ident.tenantId, async (tx) => {
      const repo = new CalendarRepository(tx);
      const updated = await repo.setVisibility(ident.tenantId, id, body.isVisible as boolean);
      if (!updated) {
        return reply.code(404).send({ error: "not_found", message: `calendar ${id} not found` });
      }
      return { id, isVisible: body.isVisible };
    });
  });

  // Fan-out: events across every visible calendar in [from, to] in
  // one round-trip from the browser. Replaces the
  // Promise.all(visibleCalendars.map(listEvents)) the calendar page
  // was doing client-side. Live-syncs each calendar (one provider
  // call apiece) and serves the merged cache.
  app.get("/api/calendars/events", async (req) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const q = req.query as { from?: string; to?: string };
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 7 * 86_400_000);
    const to = q.to ? new Date(q.to) : new Date(Date.now() + 30 * 86_400_000);
    return withTenant(deps.pool, ident.tenantId, async (tx) => {
      const repo = new CalendarRepository(tx);
      const calendars = await repo.listCalendars(ident.tenantId);
      const visible = calendars.filter((c) => c.isVisible !== false);
      // Best-effort live sync per calendar; failures fall back to the
      // cached row set (same policy as the per-calendar route).
      if (deps.credentials) {
        const accountsRepo = new OauthAccountsRepository(tx);
        for (const calendar of visible) {
          const account = await accountsRepo.byId(ident.tenantId, calendar.oauthAccountId);
          if (!account) continue;
          try {
            const accessToken = await getValidAccessToken(account, {
              tenantId: ident.tenantId,
              accounts: accountsRepo,
              credentials: deps.credentials,
            });
            const adapter = deps.calendarProviders?.for(account.provider) ?? null;
            if (!adapter) continue;
            const events = await adapter.listEvents({
              accessToken,
              calendarId: calendar.providerCalendarId,
              timeMin: from,
              timeMax: to,
            });
            for (const e of events) {
              await repo.upsertEvent({
                id: `evt_${account.id}_${stableHash(e.providerEventId)}`,
                tenantId: ident.tenantId,
                calendarId: calendar.id,
                providerEventId: e.providerEventId,
                ...(e.icalUid ? { icalUid: e.icalUid } : {}),
                ...(e.summary !== null ? { summary: e.summary } : {}),
                ...(e.description !== null ? { description: e.description } : {}),
                ...(e.location !== null ? { location: e.location } : {}),
                startsAt: e.startsAt,
                endsAt: e.endsAt,
                allDay: e.allDay,
                attendees: [...e.attendees],
                ...(e.organizerEmail !== null ? { organizerEmail: e.organizerEmail } : {}),
                ...(e.responseStatus !== null ? { responseStatus: e.responseStatus } : {}),
                ...(e.status !== null ? { status: e.status } : {}),
                rawJson: e.raw,
              });
            }
          } catch (err) {
            console.warn("[calendar] fan-out event sync failed", {
              id: calendar.id,
              err: String(err),
            });
          }
        }
      }
      const grouped: Array<{
        calendarId: string;
        events: ReadonlyArray<unknown>;
      }> = [];
      for (const calendar of visible) {
        const cached = await repo.listEventsInRange(ident.tenantId, calendar.id, from, to);
        grouped.push({
          calendarId: calendar.id,
          events: cached.map((e) => ({
            id: e.id,
            calendarId: e.calendarId,
            providerEventId: e.providerEventId,
            icalUid: e.icalUid,
            summary: e.summary,
            description: e.description,
            location: e.location,
            startsAt: e.startsAt.toISOString(),
            endsAt: e.endsAt.toISOString(),
            allDay: e.allDay,
            attendees: e.attendeesJson,
            organizerEmail: e.organizerEmail,
            responseStatus: e.responseStatus,
            status: e.status,
            meetingProvider: e.meetingProvider,
            meetingJoinUrl: e.meetingJoinUrl,
          })),
        });
      }
      return { from: from.toISOString(), to: to.toISOString(), groups: grouped };
    });
  });

  // Events in a [from, to] window across one calendar (or the user's
  // visible calendars when no calendarId is provided). Pulls live from
  // the provider on demand and upserts into our cache so subsequent
  // reads in the same window come from Postgres.
  app.get("/api/calendars/:id/events", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const { id } = req.params as { id: string };
    const q = req.query as { from?: string; to?: string };
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 7 * 86_400_000);
    const to = q.to ? new Date(q.to) : new Date(Date.now() + 30 * 86_400_000);
    return withTenant(deps.pool, ident.tenantId, async (tx) => {
      const repo = new CalendarRepository(tx);
      const calendars = await repo.listCalendars(ident.tenantId);
      const calendar = calendars.find((c) => c.id === id);
      if (!calendar) {
        return reply.code(404).send({ error: "not_found", message: `calendar ${id} not found` });
      }
      // Live fetch when credentials are wired; otherwise serve cached.
      if (deps.credentials) {
        const accountsRepo = new OauthAccountsRepository(tx);
        const account = await accountsRepo.byId(ident.tenantId, calendar.oauthAccountId);
        if (account) {
          try {
            const accessToken = await getValidAccessToken(account, {
              tenantId: ident.tenantId,
              accounts: accountsRepo,
              credentials: deps.credentials,
            });
            const adapter = deps.calendarProviders?.for(account.provider) ?? null;
            const events = adapter
              ? await adapter.listEvents({
                  accessToken,
                  calendarId: calendar.providerCalendarId,
                  timeMin: from,
                  timeMax: to,
                })
              : [];
            for (const e of events) {
              await repo.upsertEvent({
                id: `evt_${account.id}_${stableHash(e.providerEventId)}`,
                tenantId: ident.tenantId,
                calendarId: calendar.id,
                providerEventId: e.providerEventId,
                ...(e.icalUid ? { icalUid: e.icalUid } : {}),
                ...(e.summary !== null ? { summary: e.summary } : {}),
                ...(e.description !== null ? { description: e.description } : {}),
                ...(e.location !== null ? { location: e.location } : {}),
                startsAt: e.startsAt,
                endsAt: e.endsAt,
                allDay: e.allDay,
                attendees: [...e.attendees],
                ...(e.organizerEmail !== null ? { organizerEmail: e.organizerEmail } : {}),
                ...(e.responseStatus !== null ? { responseStatus: e.responseStatus } : {}),
                ...(e.status !== null ? { status: e.status } : {}),
                rawJson: e.raw,
              });
            }
          } catch (err) {
            console.warn("[calendar] event sync failed", { id: calendar.id, err: String(err) });
          }
        }
      }
      const cached = await repo.listEventsInRange(ident.tenantId, calendar.id, from, to);
      return {
        events: cached.map((e) => ({
          id: e.id,
          providerEventId: e.providerEventId,
          icalUid: e.icalUid,
          summary: e.summary,
          description: e.description,
          location: e.location,
          startsAt: e.startsAt.toISOString(),
          endsAt: e.endsAt.toISOString(),
          allDay: e.allDay,
          attendees: e.attendeesJson,
          organizerEmail: e.organizerEmail,
          responseStatus: e.responseStatus,
          status: e.status,
          meetingProvider: e.meetingProvider,
          meetingJoinUrl: e.meetingJoinUrl,
        })),
      };
    });
  });
}

// Stable, short, URL-safe hash of a provider id. Used as a suffix on
// our local row ids so they're easy to debug in logs (the prefix tells
// you the account, the suffix tells you the upstream id) without
// shipping the raw provider ids inside our PKs.
function stableHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36).padStart(7, "0");
}
