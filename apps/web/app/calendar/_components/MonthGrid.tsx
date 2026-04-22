import { useMemo, useRef, useState } from "react";
import { Popover } from "@mailai/ui";
import { useTranslator } from "../../lib/i18n/useTranslator";
import {
  endOfMonthGrid,
  sameDay,
  sameMonth,
  startOfMonthGrid,
  startOfMonth,
} from "../_lib/calendar-time";
import type { CalendarEvent } from "../_lib/useCalendarState";

interface Props {
  readonly cursor: Date;
  readonly events: ReadonlyArray<CalendarEvent>;
  readonly colorForCalendar: (calendarId: string) => string;
  readonly onCreateOnDay: (day: Date, anchor: HTMLElement) => void;
  readonly onSelectEvent: (event: CalendarEvent, anchor: HTMLElement) => void;
  readonly onMoveEventToDay: (event: CalendarEvent, day: Date) => Promise<void> | void;
}

const MAX_CHIPS = 3;

// 6×7 month grid. Each day cell shows up to MAX_CHIPS chips followed
// by a "+N more" link that opens a popover with the rest. Drag-and-
// drop is at day granularity; the time stays fixed.
export function MonthGrid({
  cursor,
  events,
  colorForCalendar,
  onCreateOnDay,
  onSelectEvent,
  onMoveEventToDay,
}: Props) {
  const { t } = useTranslator();
  const monthStart = startOfMonth(cursor);
  const gridStart = useMemo(() => startOfMonthGrid(cursor), [cursor]);
  const gridEnd = useMemo(() => endOfMonthGrid(cursor), [cursor]);
  const days = useMemo<Date[]>(() => {
    const out: Date[] = [];
    for (let t = gridStart.getTime(); t < gridEnd.getTime(); t += 86_400_000) {
      out.push(new Date(t));
    }
    return out;
  }, [gridStart.getTime(), gridEnd.getTime()]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of events) {
      const start = new Date(e.startsAt);
      const end = new Date(e.endsAt);
      // Walk every day the event covers; multi-day events show on
      // each cell.
      for (
        let t = start.getTime();
        t < Math.max(end.getTime(), start.getTime() + 1);
        t += 86_400_000
      ) {
        const day = new Date(t);
        day.setHours(0, 0, 0, 0);
        const key = day.toISOString();
        const list = map.get(key) ?? [];
        list.push(e);
        map.set(key, list);
        if (start.getTime() === end.getTime()) break;
      }
    }
    return map;
  }, [events]);

  const [overflow, setOverflow] = useState<{
    day: Date;
    events: CalendarEvent[];
    anchor: HTMLElement;
  } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const today = new Date();
  const weekdayLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
    return Array.from({ length: 7 }, (_, i) =>
      fmt.format(new Date(gridStart.getTime() + i * 86_400_000)),
    );
  }, [gridStart.getTime()]);

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-divider bg-surface">
      <div className="grid grid-cols-7 border-b border-divider text-[11px] uppercase tracking-wide text-secondary">
        {weekdayLabels.map((l, i) => (
          <div key={i} className="px-2 py-1.5 text-center">
            {l}
          </div>
        ))}
      </div>
      <div className="grid flex-1 grid-cols-7 grid-rows-6">
        {days.map((day) => {
          const inMonth = sameMonth(day, monthStart);
          const isToday = sameDay(day, today);
          const list = eventsByDay.get(isoOf(day)) ?? [];
          list.sort(
            (a, b) =>
              new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
          );
          const visible = list.slice(0, MAX_CHIPS);
          const hidden = list.length - visible.length;
          return (
            <div
              key={day.toISOString()}
              onDragOver={(e) => {
                if (dragId) e.preventDefault();
              }}
              onDrop={(e) => {
                if (!dragId) return;
                e.preventDefault();
                const ev = events.find((x) => x.id === dragId);
                if (ev) void onMoveEventToDay(ev, day);
                setDragId(null);
              }}
              className={
                "flex min-h-0 flex-col gap-0.5 border-b border-l border-divider px-1 py-0.5 " +
                (inMonth ? "bg-background" : "bg-surface/40")
              }
            >
              <button
                type="button"
                onClick={(e) => onCreateOnDay(day, e.currentTarget)}
                className={
                  "self-end rounded-full px-1.5 text-[11px] " +
                  (isToday
                    ? "bg-accent font-semibold text-white"
                    : inMonth
                      ? "text-foreground hover:bg-hover"
                      : "text-tertiary hover:bg-hover")
                }
              >
                {day.getDate()}
              </button>
              <div className="flex min-h-0 flex-col gap-0.5">
                {visible.map((ev) => (
                  <MonthChip
                    key={ev.id}
                    event={ev}
                    color={colorForCalendar(ev.calendarId)}
                    onPick={(e) =>
                      onSelectEvent(ev, e.currentTarget as HTMLElement)
                    }
                    onDragStart={() => setDragId(ev.id)}
                    onDragEnd={() => setDragId(null)}
                  />
                ))}
                {hidden > 0 && (
                  <button
                    type="button"
                    onClick={(e) =>
                      setOverflow({
                        day,
                        events: list,
                        anchor: e.currentTarget,
                      })
                    }
                    className="text-left text-[11px] text-secondary hover:text-foreground"
                  >
                    {t("calendar.moreEvents", { count: hidden })}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {overflow && (
        <Popover
          open={true}
          onClose={() => setOverflow(null)}
          anchor={overflow.anchor}
          placement="bottom"
          className="w-64"
        >
          <header className="mb-2 text-sm font-semibold">
            {overflow.day.toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
          </header>
          <ul className="flex max-h-72 flex-col gap-1 overflow-auto">
            {overflow.events.map((ev) => (
              <li key={ev.id}>
                <button
                  type="button"
                  onClick={(e) => {
                    onSelectEvent(ev, e.currentTarget as HTMLElement);
                    setOverflow(null);
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-hover"
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: colorForCalendar(ev.calendarId) }}
                  />
                  <span className="flex-1 truncate">
                    {ev.summary || "(no title)"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Popover>
      )}
    </div>
  );
}

function isoOf(day: Date): string {
  const d = new Date(day);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

interface MonthChipProps {
  readonly event: CalendarEvent;
  readonly color: string;
  readonly onPick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  readonly onDragStart: () => void;
  readonly onDragEnd: () => void;
}

function MonthChip({
  event,
  color,
  onPick,
  onDragStart,
  onDragEnd,
}: MonthChipProps) {
  const ref = useRef<HTMLButtonElement | null>(null);
  return (
    <button
      ref={ref}
      type="button"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", event.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={onPick}
      className="flex items-center gap-1 truncate rounded px-1 py-0.5 text-left text-[11px] text-white"
      style={{ backgroundColor: color }}
    >
      <span className="truncate font-medium">
        {event.summary || "(no title)"}
      </span>
    </button>
  );
}
