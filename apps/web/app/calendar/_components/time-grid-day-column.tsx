import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  SNAP_MINUTES,
  addDays,
  pxToDate,
  sameDay,
  snapMinutes,
  startOfDay,
} from "../_lib/calendar-time";
import { layoutDayEvents, type LaidOutEvent } from "../_lib/event-layout";
import type { CalendarEvent } from "../_lib/useCalendarState";

export const HOUR_HEIGHT = 48;
export const TOTAL_HEIGHT = HOUR_HEIGHT * 24;

export function overlapsDay(event: CalendarEvent, day: Date): boolean {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = dayStart + 86_400_000;
  const s = new Date(event.startsAt).getTime();
  const e = new Date(event.endsAt).getTime();
  return s < dayEnd && e > dayStart;
}

export interface DayColumnProps {
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

/** One interactive day column from the week/day calendar (hour grid + events). */
export function DayColumn({
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
      {Array.from({ length: 24 }, (_, h) => (
        <div
          key={h}
          className="absolute left-0 right-0 border-t border-divider/60"
          style={{ top: h * HOUR_HEIGHT }}
        />
      ))}
      {Array.from({ length: 24 }, (_, h) => (
        <div
          key={`half-${h}`}
          className="absolute left-0 right-0 border-t border-divider/30"
          style={{ top: h * HOUR_HEIGHT + HOUR_HEIGHT / 2 }}
        />
      ))}
      {showNow && (
        <div
          className="pointer-events-none absolute left-0 right-0 z-10 flex items-center"
          style={{ top: nowTop }}
        >
          <span className="-ml-1 inline-block h-2 w-2 rounded-full bg-error" />
          <span className="h-px flex-1 bg-error" />
        </div>
      )}
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
        if ((e.target as HTMLElement).closest("[data-resize-handle]")) return;
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
