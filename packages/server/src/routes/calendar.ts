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
import {
  getValidAccessToken,
  listGoogleCalendars,
  listGoogleEvents,
  listGraphCalendars,
  listGraphEvents,
  type ProviderCredentials,
} from "@mailai/oauth-tokens";

export interface CalendarRoutesDeps {
  readonly pool: Pool;
  readonly identity: (req: { headers: Record<string, unknown> }) => Promise<{
    userId: string;
    tenantId: string;
  }>;
  readonly credentials?: ProviderCredentials;
}

export function registerCalendarRoutes(
  app: FastifyInstance,
  deps: CalendarRoutesDeps,
): void {
  app.get("/api/calendars", async (req) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    return withTenant(deps.pool, ident.tenantId, async (tx) => {
      const repo = new CalendarRepository(tx);
      const list = await repo.listCalendars(ident.tenantId);
      return {
        calendars: list.map((c) => ({
          id: c.id,
          name: c.name,
          color: c.color,
          provider: c.provider,
          isPrimary: c.isPrimary,
          isVisible: c.isVisible,
        })),
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
          const cals =
            account.provider === "google-mail"
              ? await listGoogleCalendars({ accessToken })
              : account.provider === "outlook"
                ? await listGraphCalendars({ accessToken })
                : [];
          for (const c of cals) {
            await repo.upsertCalendar({
              id: `cal_${account.id}_${stableHash(c.providerCalendarId)}`,
              tenantId: ident.tenantId,
              oauthAccountId: account.id,
              provider: account.provider as "google-mail" | "outlook",
              providerCalendarId: c.providerCalendarId,
              name: c.name,
              color: c.color,
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
            const events =
              account.provider === "google-mail"
                ? await listGoogleEvents({
                    accessToken,
                    calendarId: calendar.providerCalendarId,
                    timeMin: from,
                    timeMax: to,
                  })
                : account.provider === "outlook"
                  ? await listGraphEvents({
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
