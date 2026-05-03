import { useLayoutEffect, useMemo, useRef } from "react";
import { useTranslator } from "../../lib/i18n/useTranslator";
import { addDays, sameDay, startOfDay, startOfWeek, type CalendarView } from "../_lib/calendar-time";
import type { CalendarEvent } from "../_lib/useCalendarState";
import {
  DayColumn,
  HOUR_HEIGHT,
  TOTAL_HEIGHT,
  overlapsDay,
} from "./time-grid-day-column";

interface Props {
  readonly view: Extract<CalendarView, "day" | "week">;
  readonly cursor: Date;
  readonly events: ReadonlyArray<CalendarEvent>;
  readonly colorForCalendar: (calendarId: string) => string;
  // Used to attribute new draft events. Provider-agnostic — the
  // dialog asks the user to confirm the calendar before persisting.
  readonly onCreateRange: (
    args: { start: Date; end: Date; allDay: boolean },
    anchor: HTMLElement | DOMRect,
  ) => void;
  readonly onSelectEvent: (event: CalendarEvent, anchor: HTMLElement) => void;
  readonly onMoveEvent: (
    event: CalendarEvent,
    args: { start: Date; end: Date },
  ) => Promise<void> | void;
  readonly onResizeEvent: (
    event: CalendarEvent,
    args: { start: Date; end: Date },
  ) => Promise<void> | void;
}

// Day + Week share this component because the only differences are
// (a) how many day columns we render and (b) the all-day strip's
// span. The drag handlers are identical for both.
export function TimeGrid({
  view,
  cursor,
  events,
  colorForCalendar,
  onCreateRange,
  onSelectEvent,
  onMoveEvent,
  onResizeEvent,
}: Props) {
  const { t } = useTranslator();
  const days = useMemo<Date[]>(() => {
    if (view === "day") return [startOfDay(cursor)];
    const start = startOfWeek(cursor);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [view, cursor]);

  const allDay = useMemo(() => events.filter((e) => e.allDay), [events]);
  const timed = useMemo(() => events.filter((e) => !e.allDay), [events]);

  // Auto-scroll to a few hours before "now" on first paint so the
  // viewport opens on the working day instead of midnight.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!scrollRef.current) return;
    const now = new Date();
    const hours = now.getHours() + now.getMinutes() / 60;
    const target = Math.max(0, hours - 1) * HOUR_HEIGHT;
    scrollRef.current.scrollTop = target;
  }, []);

  const hourLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
    });
    return Array.from({ length: 24 }, (_, h) =>
      h === 0 ? "" : fmt.format(new Date(2025, 0, 1, h, 0, 0)),
    );
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-divider bg-surface">
      <DayHeader days={days} />
      <AllDayStrip
        days={days}
        events={allDay}
        colorForCalendar={colorForCalendar}
        onSelectEvent={onSelectEvent}
        onCreateRange={onCreateRange}
        labelAllDay={t("calendar.allDay")}
      />
      <div ref={scrollRef} className="relative flex-1 overflow-y-auto">
        <div
          className="grid"
          style={{ gridTemplateColumns: `4rem repeat(${days.length}, minmax(0, 1fr))` }}
        >
          <HourGutter labels={hourLabels} />
          {days.map((day) => (
            <DayColumn
              key={day.toISOString()}
              day={day}
              events={timed.filter((e) => overlapsDay(e, day))}
              colorForCalendar={colorForCalendar}
              onCreateRange={onCreateRange}
              onSelectEvent={onSelectEvent}
              onMoveEvent={onMoveEvent}
              onResizeEvent={onResizeEvent}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function DayHeader({ days }: { days: Date[] }) {
  const today = new Date();
  return (
    <div
      className="grid border-b border-divider"
      style={{ gridTemplateColumns: `4rem repeat(${days.length}, minmax(0, 1fr))` }}
    >
      <div />
      {days.map((day) => {
        const isToday = sameDay(day, today);
        return (
          <div key={day.toISOString()} className="px-2 py-2 text-center">
            <div className="text-[11px] uppercase tracking-wide text-secondary">
              {day.toLocaleDateString(undefined, { weekday: "short" })}
            </div>
            <div
              className={
                "mx-auto mt-0.5 inline-flex h-7 w-7 items-center justify-center rounded-full text-sm " +
                (isToday ? "bg-accent font-semibold text-on-accent" : "text-foreground")
              }
            >
              {day.getDate()}
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface AllDayStripProps {
  readonly days: Date[];
  readonly events: ReadonlyArray<CalendarEvent>;
  readonly colorForCalendar: (calendarId: string) => string;
  readonly onSelectEvent: (event: CalendarEvent, anchor: HTMLElement) => void;
  readonly onCreateRange: (
    args: { start: Date; end: Date; allDay: boolean },
    anchor: HTMLElement | DOMRect,
  ) => void;
  readonly labelAllDay: string;
}

function AllDayStrip({
  days,
  events,
  colorForCalendar,
  onSelectEvent,
  onCreateRange,
  labelAllDay,
}: AllDayStripProps) {
  return (
    <div
      className="grid border-b border-divider bg-background/30 text-[11px]"
      style={{ gridTemplateColumns: `4rem repeat(${days.length}, minmax(0, 1fr))` }}
    >
      <div className="px-2 py-1 text-right text-[10px] uppercase tracking-wide text-tertiary">
        {labelAllDay}
      </div>
      {days.map((day) => {
        const dayEvents = events.filter((e) => overlapsDay(e, day));
        return (
          <button
            key={day.toISOString()}
            type="button"
            onClick={(e) => {
              const start = startOfDay(day);
              const end = addDays(start, 1);
              onCreateRange({ start, end, allDay: true }, e.currentTarget);
            }}
            className="flex min-h-[1.75rem] flex-col gap-0.5 border-l border-divider px-1 py-1 text-left hover:bg-hover"
          >
            {dayEvents.map((ev) => (
              <span
                key={ev.id}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectEvent(ev, e.currentTarget as HTMLElement);
                }}
                className="truncate rounded px-1.5 py-0.5 text-[11px] font-medium text-on-accent"
                style={{ backgroundColor: colorForCalendar(ev.calendarId) }}
              >
                {ev.summary || "(no title)"}
              </span>
            ))}
          </button>
        );
      })}
    </div>
  );
}

function HourGutter({ labels }: { labels: ReadonlyArray<string> }) {
  return (
    <div className="relative" style={{ height: TOTAL_HEIGHT }}>
      {labels.map((label, h) => (
        <div
          key={h}
          className="absolute right-2 -translate-y-1/2 text-[10px] uppercase text-tertiary"
          style={{ top: h * HOUR_HEIGHT }}
        >
          {label}
        </div>
      ))}
    </div>
  );
}
