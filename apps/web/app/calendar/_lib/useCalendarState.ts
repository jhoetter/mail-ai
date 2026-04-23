import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listCalendars,
  listEventsRange,
  setCalendarVisibility,
  syncCalendars,
  type CalendarSummary,
  type EventSummary,
} from "../../lib/calendar-client";

// Flat representation used by the grids — every event carries the
// id of the calendar it lives on so the grid can paint it with that
// calendar's color without doing a second join.
export interface CalendarEvent extends EventSummary {
  readonly calendarId: string;
}
import { useMutationEvents } from "../../lib/realtime";
import { addDays, addMonths, viewWindow, type CalendarView } from "./calendar-time";

export interface CalendarPopoverState {
  readonly kind: "quick-create" | "details";
  readonly anchor: HTMLElement | DOMRect;
  readonly defaults?: { calendarId: string; start: Date; end: Date; allDay: boolean };
  readonly eventId?: string;
}

export interface DialogState {
  readonly mode: "create" | "edit";
  readonly calendarId: string;
  readonly start: Date;
  readonly end: Date;
  readonly allDay: boolean;
  readonly eventId?: string;
}

// One state machine for the whole calendar shell. Splitting per-
// concern hooks here would mean threading 6 setters into every leaf;
// a single hook keeps the handlers honest and makes the realtime
// invalidation a one-liner.
export function useCalendarState() {
  const [view, setView] = useState<CalendarView>("week");
  const [cursor, setCursor] = useState<Date>(() => new Date());
  const [calendars, setCalendars] = useState<CalendarSummary[] | null>(null);
  const [eventsByCalendar, setEventsByCalendar] = useState<
    ReadonlyArray<{ calendarId: string; events: EventSummary[] }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [popover, setPopover] = useState<CalendarPopoverState | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);

  const refreshCalendars = useCallback(() => {
    listCalendars()
      .then(setCalendars)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    refreshCalendars();
  }, [refreshCalendars]);

  // Fetch events for the current view window. The fan-out endpoint
  // returns one group per visible calendar; we keep the shape so the
  // grids can colour events per calendar without a join.
  useEffect(() => {
    if (calendars === null) return;
    let cancelled = false;
    const { from, to } = viewWindow(view, cursor);
    listEventsRange(from, to)
      .then((data) => {
        if (cancelled) return;
        setEventsByCalendar(data.groups);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [view, cursor, calendars, revision]);

  // Cross-tab + same-tab realtime invalidation. Any successful event
  // mutation bumps the revision counter, which re-runs the effect
  // above. The mutation envelope already filters to subjectKind=event
  // on the server, so this never fires for thread/inbox writes.
  const onMutation = useCallback(() => {
    setRevision((r) => r + 1);
  }, []);
  useMutationEvents("event", onMutation);

  const visibleCalendars = useMemo(() => calendars?.filter((c) => c.isVisible) ?? [], [calendars]);

  const events = useMemo<CalendarEvent[]>(
    () =>
      eventsByCalendar.flatMap((g) => g.events.map((e) => ({ ...e, calendarId: g.calendarId }))),
    [eventsByCalendar],
  );

  // Color lookup the grids use to paint event blocks. Falls back to
  // a neutral hue when a calendar's color is null (Outlook
  // sometimes returns blank).
  const colorForCalendar = useCallback(
    (calendarId: string): string => {
      const c = calendars?.find((cal) => cal.id === calendarId);
      return c?.color ?? "#94a3b8";
    },
    [calendars],
  );

  const onSync = useCallback(async () => {
    setBusy(true);
    try {
      await syncCalendars();
      refreshCalendars();
      setRevision((r) => r + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [refreshCalendars]);

  const onToggleCalendar = useCallback(async (id: string, next: boolean) => {
    // Optimistic flip — undo on failure.
    setCalendars((prev) =>
      prev ? prev.map((c) => (c.id === id ? { ...c, isVisible: next } : c)) : prev,
    );
    try {
      await setCalendarVisibility(id, next);
      setRevision((r) => r + 1);
    } catch (err) {
      setCalendars((prev) =>
        prev ? prev.map((c) => (c.id === id ? { ...c, isVisible: !next } : c)) : prev,
      );
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const onPrev = useCallback(() => {
    setCursor((c) => {
      switch (view) {
        case "day":
          return addDays(c, -1);
        case "week":
          return addDays(c, -7);
        case "month":
          return addMonths(c, -1);
      }
    });
  }, [view]);

  const onNext = useCallback(() => {
    setCursor((c) => {
      switch (view) {
        case "day":
          return addDays(c, 1);
        case "week":
          return addDays(c, 7);
        case "month":
          return addMonths(c, 1);
      }
    });
  }, [view]);

  const onToday = useCallback(() => setCursor(new Date()), []);

  return {
    view,
    setView,
    cursor,
    setCursor,
    calendars,
    visibleCalendars,
    eventsByCalendar,
    events,
    colorForCalendar,
    error,
    setError,
    busy,
    onSync,
    onToggleCalendar,
    onPrev,
    onNext,
    onToday,
    popover,
    setPopover,
    dialog,
    setDialog,
    bumpRevision: () => setRevision((r) => r + 1),
  };
}

export type CalendarStateApi = ReturnType<typeof useCalendarState>;
