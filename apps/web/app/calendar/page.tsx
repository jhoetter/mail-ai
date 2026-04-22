"use client";

import { Button, Card, Dialog, Input, PageHeader, Shell } from "@mailai/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppNav } from "../components/AppNav";
import { useTranslator } from "../lib/i18n/useTranslator";
import {
  createEvent,
  deleteEvent,
  listCalendars,
  listEvents,
  respondEvent,
  syncCalendars,
  type CalendarSummary,
  type EventSummary,
} from "../lib/calendar-client";

export default function CalendarPage() {
  const { t } = useTranslator();
  const [calendars, setCalendars] = useState<CalendarSummary[] | null>(null);
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date()));
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeDefaults, setComposeDefaults] = useState<{
    start: Date;
    end: Date;
  } | null>(null);
  const [composeCalendarId, setComposeCalendarId] = useState<string | null>(null);

  const refreshCalendars = useCallback(() => {
    listCalendars()
      .then(setCalendars)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    refreshCalendars();
  }, [refreshCalendars]);

  const visibleCalendars = useMemo(
    () => calendars?.filter((c) => c.isVisible) ?? [],
    [calendars],
  );

  useEffect(() => {
    if (visibleCalendars.length === 0) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    const from = weekStart;
    const to = new Date(weekStart.getTime() + 7 * 24 * 60 * 60_000);
    Promise.all(visibleCalendars.map((c) => listEvents(c.id, from, to)))
      .then((lists) => {
        if (cancelled) return;
        setEvents(lists.flat());
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [visibleCalendars, weekStart]);

  const onSync = async () => {
    setBusy(true);
    try {
      await syncCalendars();
      refreshCalendars();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const days = useMemo(() => {
    const out: Date[] = [];
    for (let i = 0; i < 7; i++) {
      out.push(new Date(weekStart.getTime() + i * 24 * 60 * 60_000));
    }
    return out;
  }, [weekStart]);

  const openCompose = (start: Date, end: Date) => {
    if (visibleCalendars.length === 0) return;
    setComposeCalendarId(visibleCalendars[0]!.id);
    setComposeDefaults({ start, end });
    setComposeOpen(true);
  };

  return (
    <Shell sidebar={<AppNav />}>
      <PageHeader
        title={t("calendar.title")}
        subtitle={t("calendar.subtitle")}
        actions={
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setWeekStart((w) => new Date(w.getTime() - 7 * 24 * 60 * 60_000))
              }
            >
              {t("calendar.previous")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setWeekStart(startOfWeek(new Date()))}
            >
              {t("calendar.today")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setWeekStart((w) => new Date(w.getTime() + 7 * 24 * 60 * 60_000))
              }
            >
              {t("calendar.next")}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void onSync()}>
              {t("calendar.syncCalendars")}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={visibleCalendars.length === 0}
              onClick={() => {
                const now = new Date();
                const start = new Date(now);
                start.setMinutes(0, 0, 0);
                const end = new Date(start.getTime() + 60 * 60_000);
                openCompose(start, end);
              }}
            >
              {t("calendar.newEvent")}
            </Button>
          </div>
        }
      />
      {error ? <p className="text-sm text-error">{error}</p> : null}
      {calendars === null ? (
        <p className="text-sm text-secondary">{t("common.loading")}</p>
      ) : calendars.length === 0 ? (
        <Card>
          <p className="text-sm text-secondary">{t("calendar.noCalendars")}</p>
        </Card>
      ) : (
        <Card>
          <WeekGrid
            days={days}
            events={events}
            calendars={visibleCalendars}
            onSlotClick={openCompose}
            onRespond={async (event, response) => {
              try {
                await respondEvent({ eventId: event.id, response });
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
            onDelete={async (event) => {
              if (!confirm("Delete event?")) return;
              try {
                await deleteEvent(event.id);
                setEvents((prev) => prev.filter((e) => e.id !== event.id));
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
          />
        </Card>
      )}
      {composeOpen && composeDefaults && composeCalendarId ? (
        <EventComposer
          open={composeOpen}
          calendars={visibleCalendars}
          calendarId={composeCalendarId}
          defaults={composeDefaults}
          onClose={() => setComposeOpen(false)}
          onCreated={() => {
            setComposeOpen(false);
            // Trigger event reload by nudging weekStart to a new Date instance.
            setWeekStart((w) => new Date(w));
          }}
        />
      ) : null}
    </Shell>
  );
}

function startOfWeek(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const offset = (day + 6) % 7;
  d.setDate(d.getDate() - offset);
  return d;
}

interface WeekGridProps {
  days: Date[];
  events: EventSummary[];
  calendars: CalendarSummary[];
  onSlotClick: (start: Date, end: Date) => void;
  onRespond: (event: EventSummary, response: "accepted" | "declined" | "tentative") => Promise<void>;
  onDelete: (event: EventSummary) => Promise<void>;
}

function WeekGrid({ days, events, onSlotClick, onRespond, onDelete }: WeekGridProps) {
  const { t } = useTranslator();
  return (
    <div className="grid grid-cols-7 gap-2 overflow-x-auto">
      {days.map((day) => {
        const dayEvents = events
          .filter((e) => sameDay(new Date(e.startsAt), day))
          .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
        return (
          <div key={day.toISOString()} className="flex min-w-[8rem] flex-col gap-1">
            <button
              type="button"
              onClick={() => {
                const start = new Date(day);
                start.setHours(9, 0, 0, 0);
                const end = new Date(start.getTime() + 60 * 60_000);
                onSlotClick(start, end);
              }}
              className="rounded-md border border-divider bg-background/40 px-2 py-1 text-left text-xs text-secondary hover:bg-background/60"
            >
              <div className="font-semibold text-foreground">
                {day.toLocaleDateString(undefined, { weekday: "short" })}
              </div>
              <div>{day.toLocaleDateString(undefined, { day: "numeric", month: "short" })}</div>
            </button>
            <div className="flex flex-col gap-1">
              {dayEvents.map((event) => (
                <div
                  key={event.id}
                  className="rounded-md border border-divider bg-surface p-2 text-xs"
                >
                  <div className="font-medium">{event.summary || t("common.untitled")}</div>
                  <div className="text-[10px] text-secondary">
                    {formatTime(event.startsAt)} – {formatTime(event.endsAt)}
                  </div>
                  {event.location ? (
                    <div className="text-[10px] text-secondary">{event.location}</div>
                  ) : null}
                  <div className="mt-1 flex flex-wrap gap-1">
                    <button
                      type="button"
                      className="rounded bg-background/60 px-1.5 py-0.5 text-[10px] hover:bg-background"
                      onClick={() => void onRespond(event, "accepted")}
                    >
                      {t("calendar.accept")}
                    </button>
                    <button
                      type="button"
                      className="rounded bg-background/60 px-1.5 py-0.5 text-[10px] hover:bg-background"
                      onClick={() => void onRespond(event, "tentative")}
                    >
                      {t("calendar.tentative")}
                    </button>
                    <button
                      type="button"
                      className="rounded bg-background/60 px-1.5 py-0.5 text-[10px] hover:bg-background"
                      onClick={() => void onRespond(event, "declined")}
                    >
                      {t("calendar.decline")}
                    </button>
                    <button
                      type="button"
                      className="rounded bg-background/60 px-1.5 py-0.5 text-[10px] text-error hover:bg-background"
                      onClick={() => void onDelete(event)}
                    >
                      {t("common.delete")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface EventComposerProps {
  open: boolean;
  calendars: CalendarSummary[];
  calendarId: string;
  defaults: { start: Date; end: Date };
  onClose: () => void;
  onCreated: () => void;
}

function EventComposer({
  open,
  calendars,
  calendarId: initialCalendarId,
  defaults,
  onClose,
  onCreated,
}: EventComposerProps) {
  const { t } = useTranslator();
  const [calendarId, setCalendarId] = useState(initialCalendarId);
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [startsAt, setStartsAt] = useState(toLocalInput(defaults.start));
  const [endsAt, setEndsAt] = useState(toLocalInput(defaults.end));
  const [attendees, setAttendees] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await createEvent({
        calendarId,
        summary,
        ...(description ? { description } : {}),
        ...(location ? { location } : {}),
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
        attendees: attendees
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      });
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose}>
      <h3 className="text-base font-semibold">{t("calendar.newEvent")}</h3>
      <div className="mt-3 flex flex-col gap-2">
        <select
          value={calendarId}
          onChange={(e) => setCalendarId(e.target.value)}
          className="h-9 rounded-md border border-divider bg-background px-2 text-sm"
        >
          {calendars.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <Input
          placeholder={t("calendar.eventTitle")}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
        <textarea
          className="min-h-20 w-full rounded-md border border-divider bg-background p-2 text-sm"
          placeholder={t("calendar.eventDescription")}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <Input
          placeholder={t("calendar.eventLocation")}
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        />
        <label className="text-xs text-secondary">{t("calendar.eventStart")}</label>
        <input
          type="datetime-local"
          value={startsAt}
          onChange={(e) => setStartsAt(e.target.value)}
          className="h-9 rounded-md border border-divider bg-background px-2 text-sm"
        />
        <label className="text-xs text-secondary">{t("calendar.eventEnd")}</label>
        <input
          type="datetime-local"
          value={endsAt}
          onChange={(e) => setEndsAt(e.target.value)}
          className="h-9 rounded-md border border-divider bg-background px-2 text-sm"
        />
        <Input
          placeholder={t("calendar.eventAttendees")}
          value={attendees}
          onChange={(e) => setAttendees(e.target.value)}
        />
        {err ? <p className="text-xs text-error">{err}</p> : null}
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy || summary.trim().length === 0}
            onClick={() => void submit()}
          >
            {busy ? t("composer.sending") : t("common.save")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}
