import { useMemo } from "react";
import { Button } from "@mailai/ui";
import { useTranslator } from "../../lib/i18n/useTranslator";
import type { CalendarSummary } from "../../lib/calendar-client";
import {
  addMonths,
  endOfMonthGrid,
  sameDay,
  sameMonth,
  startOfMonth,
  startOfMonthGrid,
} from "../_lib/calendar-time";

interface Props {
  readonly cursor: Date;
  readonly onCursorChange: (next: Date) => void;
  readonly calendars: ReadonlyArray<CalendarSummary>;
  readonly onToggleCalendar: (id: string, next: boolean) => void;
  readonly onCreate: () => void;
}

// Sidebar = create button (matches Google's prominent button), the
// mini-month grid that drives `cursor`, and a per-calendar checkbox
// list with the calendar's color dot. Provider-agnostic: every
// calendar lands here regardless of provider; the dot color falls
// back to a neutral hue when the provider didn't ship one.
export function Sidebar({ cursor, onCursorChange, calendars, onToggleCalendar, onCreate }: Props) {
  const { t } = useTranslator();
  return (
    <aside className="flex h-full w-60 flex-col gap-4 border-r border-divider bg-surface/40 px-3 py-4">
      <Button size="sm" variant="primary" className="w-full" onClick={onCreate}>
        {t("calendar.newEvent")}
      </Button>
      <MiniMonth cursor={cursor} onSelect={onCursorChange} />
      <section>
        <h3 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-secondary">
          {t("calendar.myCalendars")}
        </h3>
        <ul className="flex flex-col gap-0.5">
          {calendars.map((c) => (
            <li key={c.id}>
              <label className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-hover">
                <input
                  type="checkbox"
                  checked={c.isVisible}
                  onChange={(e) => onToggleCalendar(c.id, e.target.checked)}
                  className="sr-only"
                />
                <ColorChip color={c.color} active={c.isVisible} />
                <span className="flex-1 truncate text-foreground">{c.name}</span>
              </label>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}

// Tiny color-keyed checkbox surrogate: the actual <input> is visually
// hidden so the entire row is the click target. When the calendar
// is visible the chip is filled, otherwise outlined — Google does the
// same trick.
function ColorChip({ color, active }: { color: string | null; active: boolean }) {
  const c = color ?? "var(--color-tertiary)";
  return (
    <span
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] border"
      style={{ borderColor: c, backgroundColor: active ? c : "transparent" }}
      aria-hidden
    >
      {active ? <CheckIcon /> : null}
    </span>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3 text-on-accent" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M2 6.5L5 9.5L10 3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface MiniMonthProps {
  readonly cursor: Date;
  readonly onSelect: (date: Date) => void;
}

function MiniMonth({ cursor, onSelect }: MiniMonthProps) {
  const today = new Date();
  const monthStart = startOfMonth(cursor);
  const gridStart = startOfMonthGrid(cursor);
  const gridEnd = endOfMonthGrid(cursor);
  const days: Date[] = useMemo(() => {
    const out: Date[] = [];
    for (let t = gridStart.getTime(); t < gridEnd.getTime(); t += 86_400_000) {
      out.push(new Date(t));
    }
    return out;
  }, [gridStart.getTime(), gridEnd.getTime()]);
  const monthLabel = monthStart.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
  const weekdayLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(undefined, { weekday: "narrow" });
    const out: string[] = [];
    for (let i = 0; i < 7; i++) {
      out.push(fmt.format(new Date(gridStart.getTime() + i * 86_400_000)));
    }
    return out;
  }, [gridStart.getTime()]);
  return (
    <section>
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="text-xs font-medium text-foreground">{monthLabel}</span>
        <div className="flex gap-0.5">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => onSelect(addMonths(cursor, -1))}
            className="inline-flex h-5 w-5 items-center justify-center rounded text-secondary hover:bg-hover hover:text-foreground"
          >
            ‹
          </button>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => onSelect(addMonths(cursor, 1))}
            className="inline-flex h-5 w-5 items-center justify-center rounded text-secondary hover:bg-hover hover:text-foreground"
          >
            ›
          </button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-0.5 px-0.5 text-center text-[10px] text-tertiary">
        {weekdayLabels.map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-0.5 px-0.5">
        {days.map((d) => {
          const inMonth = sameMonth(d, monthStart);
          const isToday = sameDay(d, today);
          const isCursor = sameDay(d, cursor);
          return (
            <button
              key={d.toISOString()}
              type="button"
              onClick={() => onSelect(d)}
              className={
                "h-6 w-6 rounded-full text-[11px] transition-colors " +
                (isCursor
                  ? "bg-accent text-on-accent"
                  : isToday
                    ? "ring-1 ring-accent text-foreground"
                    : inMonth
                      ? "text-foreground hover:bg-hover"
                      : "text-tertiary hover:bg-hover")
              }
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </section>
  );
}
