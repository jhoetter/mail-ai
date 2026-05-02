import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslator } from "../../lib/i18n/useTranslator";
import {
  SNAP_MINUTES,
  addDays,
  pxToDate,
  sameDay,
  snapMinutes,
  startOfDay,
  startOfWeek,
  type CalendarView,
} from "../_lib/calendar-time";
import { layoutDayEvents, type LaidOutEvent } from "../_lib/event-layout";
import type { CalendarEvent } from "../_lib/useCalendarState";

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

const HOUR_HEIGHT = 48;
const TOTAL_HEIGHT = HOUR_HEIGHT * 24;

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

function overlapsDay(event: CalendarEvent, day: Date): boolean {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = dayStart + 86_400_000;
  const s = new Date(event.startsAt).getTime();
  const e = new Date(event.endsAt).getTime();
  return s < dayEnd && e > dayStart;
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

interface DayColumnProps {
  readonly day: Date;
  readonly events: ReadonlyArray<CalendarEvent>;
  readonly colorForCalendar: (calendarId: string) => string;
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

interface DragState {
  readonly kind: "create" | "move" | "resize";
  readonly eventId?: string;
  readonly originDayStart: Date;
  readonly anchorY: number;
  readonly fixedStart?: Date;
  readonly initialDurationMin?: number;
  start: Date;
  end: Date;
}

function DayColumn({
  day,
  events,
  colorForCalendar,
  onCreateRange,
  onSelectEvent,
  onMoveEvent,
  onResizeEvent,
}: DayColumnProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dayStart = useMemo(() => startOfDay(day), [day]);
  const dayEnd = useMemo(() => addDays(dayStart, 1), [dayStart]);
  const laid = useMemo(() => layoutDayEvents(events, dayStart, dayEnd), [events, dayStart, dayEnd]);

  // Pointer math: convert a clientY → snapped Date inside this day's
  // column. We measure the column rect on every pointer event so the
  // computation stays correct even after the page scrolls.
  const yToDate = useCallback(
    (clientY: number): Date => {
      const rect = ref.current?.getBoundingClientRect();
      if (!rect) return dayStart;
      return pxToDate(dayStart, HOUR_HEIGHT, clientY - rect.top);
    },
    [dayStart],
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("[data-event-tile]")) return;
    e.preventDefault();
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    const start = yToDate(e.clientY);
    const end = new Date(start.getTime() + SNAP_MINUTES * 60_000);
    setDrag({
      kind: "create",
      originDayStart: dayStart,
      anchorY: e.clientY,
      start,
      end,
    });
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    if (drag.kind === "create") {
      const cur = yToDate(e.clientY);
      const a = drag.start.getTime();
      const b = cur.getTime();
      const start = new Date(Math.min(a, b));
      const end = new Date(Math.max(a, b) + SNAP_MINUTES * 60_000);
      setDrag({ ...drag, start, end });
    } else if (drag.kind === "move" && drag.fixedStart) {
      const cur = yToDate(e.clientY);
      const offsetMin = (cur.getTime() - drag.fixedStart.getTime()) / 60_000;
      const snappedOffset = snapMinutes(offsetMin);
      const newStart = new Date(drag.fixedStart.getTime() + snappedOffset * 60_000);
      const newEnd = new Date(newStart.getTime() + (drag.initialDurationMin ?? 30) * 60_000);
      setDrag({ ...drag, start: newStart, end: newEnd });
    } else if (drag.kind === "resize" && drag.fixedStart) {
      const cur = yToDate(e.clientY);
      const minEnd = drag.fixedStart.getTime() + SNAP_MINUTES * 60_000;
      const end = new Date(Math.max(minEnd, cur.getTime()));
      setDrag({ ...drag, start: drag.fixedStart, end });
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    const finalDrag = drag;
    setDrag(null);
    if (finalDrag.kind === "create") {
      // Build a virtual rect for the popover anchor — the column
      // itself is the right element to point at since the dragged
      // selection has no DOM node after we clear `drag`.
      const rect = ref.current?.getBoundingClientRect();
      const top = rect
        ? rect.top + ((finalDrag.start.getTime() - dayStart.getTime()) / 3_600_000) * HOUR_HEIGHT
        : 0;
      const height = rect
        ? ((finalDrag.end.getTime() - finalDrag.start.getTime()) / 3_600_000) * HOUR_HEIGHT
        : 0;
      const anchor: DOMRect = rect
        ? new DOMRect(rect.left, top, rect.width, Math.max(height, 24))
        : new DOMRect(0, 0, 0, 0);
      onCreateRange({ start: finalDrag.start, end: finalDrag.end, allDay: false }, anchor);
      return;
    }
    const target = events.find((ev) => ev.id === finalDrag.eventId);
    if (!target) return;
    if (finalDrag.kind === "move") {
      void onMoveEvent(target, { start: finalDrag.start, end: finalDrag.end });
    } else if (finalDrag.kind === "resize") {
      void onResizeEvent(target, { start: finalDrag.start, end: finalDrag.end });
    }
  };

  // Cancel a half-finished drag if the pointer leaves the window
  // (e.g. user drags off-tab). Without this we'd silently retain
  // the visual selection.
  useEffect(() => {
    if (!drag) return;
    const cancel = () => setDrag(null);
    window.addEventListener("blur", cancel);
    return () => window.removeEventListener("blur", cancel);
  }, [drag]);

  const now = new Date();
  const showNow = sameDay(now, day);
  const nowTop = ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_HEIGHT;

  return (
    <div
      ref={ref}
      className="relative border-l border-divider"
      style={{ height: TOTAL_HEIGHT }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* Hour gridlines */}
      {Array.from({ length: 24 }, (_, h) => (
        <div
          key={h}
          className="absolute left-0 right-0 border-t border-divider/60"
          style={{ top: h * HOUR_HEIGHT }}
        />
      ))}
      {/* Half-hour ticks */}
      {Array.from({ length: 24 }, (_, h) => (
        <div
          key={`half-${h}`}
          className="absolute left-0 right-0 border-t border-divider/30"
          style={{ top: h * HOUR_HEIGHT + HOUR_HEIGHT / 2 }}
        />
      ))}
      {/* Now line */}
      {showNow && (
        <div
          className="pointer-events-none absolute left-0 right-0 z-10 flex items-center"
          style={{ top: nowTop }}
        >
          <span className="-ml-1 inline-block h-2 w-2 rounded-full bg-error" />
          <span className="h-px flex-1 bg-error" />
        </div>
      )}
      {/* Laid-out events */}
      {laid.map((it) => (
        <EventTile
          key={it.event.id}
          item={it}
          dayStart={dayStart}
          color={colorForCalendar(it.event.calendarId)}
          onSelect={(anchor) => onSelectEvent(it.event, anchor)}
          onStartMove={(e) => {
            e.preventDefault();
            e.stopPropagation();
            (ref.current as HTMLDivElement | null)?.setPointerCapture(e.pointerId);
            const startMs = new Date(it.event.startsAt).getTime();
            const endMs = new Date(it.event.endsAt).getTime();
            setDrag({
              kind: "move",
              eventId: it.event.id,
              originDayStart: dayStart,
              anchorY: e.clientY,
              fixedStart: new Date(startMs),
              initialDurationMin: (endMs - startMs) / 60_000,
              start: new Date(startMs),
              end: new Date(endMs),
            });
          }}
          onStartResize={(e) => {
            e.preventDefault();
            e.stopPropagation();
            (ref.current as HTMLDivElement | null)?.setPointerCapture(e.pointerId);
            const startMs = new Date(it.event.startsAt).getTime();
            const endMs = new Date(it.event.endsAt).getTime();
            setDrag({
              kind: "resize",
              eventId: it.event.id,
              originDayStart: dayStart,
              anchorY: e.clientY,
              fixedStart: new Date(startMs),
              initialDurationMin: (endMs - startMs) / 60_000,
              start: new Date(startMs),
              end: new Date(endMs),
            });
          }}
        />
      ))}
      {/* Drag preview */}
      {drag && drag.kind === "create" && (
        <div
          className="pointer-events-none absolute z-20 rounded border-2 border-dashed border-accent bg-accent/15"
          style={dragRectStyle(drag, dayStart)}
        />
      )}
      {drag && (drag.kind === "move" || drag.kind === "resize") && drag.eventId && (
        <div
          className="pointer-events-none absolute z-20 rounded border border-accent/40 bg-accent/15"
          style={dragRectStyle(drag, dayStart)}
        />
      )}
    </div>
  );
}

function dragRectStyle(drag: DragState, dayStart: Date): CSSProperties {
  const startMs = drag.start.getTime();
  const endMs = drag.end.getTime();
  const dayMs = dayStart.getTime();
  const top = ((startMs - dayMs) / 3_600_000) * HOUR_HEIGHT;
  const height = Math.max(((endMs - startMs) / 3_600_000) * HOUR_HEIGHT, 16);
  return {
    top,
    height,
    left: 2,
    right: 2,
  };
}

interface EventTileProps {
  readonly item: LaidOutEvent;
  readonly dayStart: Date;
  readonly color: string;
  readonly onSelect: (anchor: HTMLElement) => void;
  readonly onStartMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onStartResize: (e: ReactPointerEvent<HTMLDivElement>) => void;
}

function EventTile({
  item,
  dayStart,
  color,
  onSelect,
  onStartMove,
  onStartResize,
}: EventTileProps) {
  const top = ((item.startMs - dayStart.getTime()) / 3_600_000) * HOUR_HEIGHT;
  const height = Math.max(((item.endMs - item.startMs) / 3_600_000) * HOUR_HEIGHT, 16);
  const widthPct = 100 / item.columns;
  return (
    <div
      data-event-tile
      role="button"
      tabIndex={0}
      onClick={(e) => onSelect(e.currentTarget as HTMLElement)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(e.currentTarget as HTMLElement);
        }
      }}
      onPointerDown={(e) => {
        // Move starts when the user drags from the body of the tile;
        // the resize handle below has its own onPointerDown.
        if ((e.target as HTMLElement).closest("[data-resize-handle]")) return;
        // Distinguish a click (no movement) from a drag: we go into
        // move mode immediately and the click handler still fires
        // because we don't preventDefault when no movement happened.
        onStartMove(e);
      }}
      className="absolute cursor-pointer overflow-hidden rounded-md text-[11px] text-on-accent shadow-sm ring-1 ring-foreground/5 hover:brightness-110"
      style={{
        top,
        height,
        left: `calc(${widthPct * item.column}% + 2px)`,
        width: `calc(${widthPct}% - 4px)`,
        backgroundColor: color,
      }}
    >
      <div className="px-1.5 py-1">
        <div className="truncate font-semibold leading-tight">
          {item.event.summary || "(no title)"}
        </div>
        <div className="truncate opacity-90">
          {formatRange(new Date(item.event.startsAt), new Date(item.event.endsAt))}
        </div>
      </div>
      <span
        data-resize-handle
        onPointerDown={onStartResize}
        className="absolute bottom-0 left-0 right-0 h-1.5 cursor-ns-resize bg-foreground/0 hover:bg-foreground/20"
      />
    </div>
  );
}

function formatRange(start: Date, end: Date): string {
  const fmt = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${fmt.format(start)} – ${fmt.format(end)}`;
}
