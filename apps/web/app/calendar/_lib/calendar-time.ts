// Date helpers shared across the calendar shell, toolbar, mini-month,
// time grid and month grid. Plain functions, no React, no Date
// mutation outside helpers we've intentionally pulled into one place.

export type CalendarView = "day" | "week" | "month";

export const MS_PER_DAY = 86_400_000;

// Snap granularity for drag-to-create / drag-to-resize on the time
// grid. Google uses 15 minutes; the helpers below operate on minutes
// so a future "Continuous mode" toggle is a one-liner.
export const SNAP_MINUTES = 15;

export function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Monday-anchored week start (Google's default in most locales). If
// we ever expose a "first day of week" preference this is where it
// lives.
export function startOfWeek(date: Date): Date {
  const d = startOfDay(date);
  const day = d.getDay();
  const offset = (day + 6) % 7;
  d.setDate(d.getDate() - offset);
  return d;
}

export function endOfWeek(date: Date): Date {
  const start = startOfWeek(date);
  return new Date(start.getTime() + 7 * MS_PER_DAY);
}

export function startOfMonth(date: Date): Date {
  const d = startOfDay(date);
  d.setDate(1);
  return d;
}

// Six-row month grid: the Monday of the week that contains the 1st
// through six weeks later. Always 42 cells so the grid stays
// rectangular even in February.
export function startOfMonthGrid(date: Date): Date {
  return startOfWeek(startOfMonth(date));
}

export function endOfMonthGrid(date: Date): Date {
  const start = startOfMonthGrid(date);
  return new Date(start.getTime() + 42 * MS_PER_DAY);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

export function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function sameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

// [from, to] window for the visible view, used both as fetch bounds
// and as the predicate for "does this event belong on the grid?".
export function viewWindow(view: CalendarView, cursor: Date): { from: Date; to: Date } {
  switch (view) {
    case "day": {
      const from = startOfDay(cursor);
      return { from, to: addDays(from, 1) };
    }
    case "week": {
      const from = startOfWeek(cursor);
      return { from, to: addDays(from, 7) };
    }
    case "month": {
      return { from: startOfMonthGrid(cursor), to: endOfMonthGrid(cursor) };
    }
    default: {
      const _exhaustive: never = view;
      void _exhaustive;
      return { from: startOfDay(cursor), to: addDays(cursor, 1) };
    }
  }
}

// Snap an arbitrary minute count to the nearest multiple of SNAP_MINUTES.
// Used by the time grid drag handlers.
export function snapMinutes(minutes: number): number {
  return Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES;
}

// Pixel position → Date for a time grid lane. `dayStart` is the
// midnight of the day the column represents, `pxPerHour` is the row
// height in CSS px. Returns a Date snapped to SNAP_MINUTES.
export function pxToDate(dayStart: Date, pxPerHour: number, py: number): Date {
  const totalMinutes = (py / pxPerHour) * 60;
  const snapped = snapMinutes(Math.max(0, totalMinutes));
  const out = new Date(dayStart);
  out.setMinutes(snapped);
  return out;
}

// Format a Date as a `<input type="datetime-local">` value in local
// time. The native control needs `YYYY-MM-DDTHH:MM`.
export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

// Best-effort detect of the browser's IANA zone for the time-zone
// picker default. SSR returns "UTC" so callers get a stable value.
export function detectTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
