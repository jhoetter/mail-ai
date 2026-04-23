import { useState } from "react";
import { Button, Input, Popover } from "@mailai/ui";
import { useTranslator } from "../../lib/i18n/useTranslator";
import type { CalendarSummary } from "../../lib/calendar-client";
import { detectTimeZone, toLocalInput } from "../_lib/calendar-time";

interface Props {
  readonly open: boolean;
  readonly anchor: HTMLElement | DOMRect | null;
  readonly calendars: ReadonlyArray<CalendarSummary>;
  readonly defaults: { calendarId: string; start: Date; end: Date; allDay: boolean };
  readonly onClose: () => void;
  readonly onCreate: (input: {
    calendarId: string;
    summary: string;
    startsAt: string;
    endsAt: string;
    allDay: boolean;
    timeZone: string;
  }) => Promise<void>;
  readonly onMore: (input: {
    calendarId: string;
    summary: string;
    startsAt: string;
    endsAt: string;
    allDay: boolean;
  }) => void;
}

// Google's tiny "Add title / pick calendar / Save / More options"
// popover that appears after a drag-to-create. Only the bare
// minimum lives here; "More options" promotes to the full editor
// where attendees, recurrence and time-zone live.
export function QuickCreatePopover({
  open,
  anchor,
  calendars,
  defaults,
  onClose,
  onCreate,
  onMore,
}: Props) {
  const { t } = useTranslator();
  const [summary, setSummary] = useState("");
  const [calendarId, setCalendarId] = useState(defaults.calendarId);
  const [busy, setBusy] = useState(false);
  const tz = detectTimeZone();

  const submit = async () => {
    if (summary.trim().length === 0) return;
    setBusy(true);
    try {
      await onCreate({
        calendarId,
        summary: summary.trim(),
        startsAt: defaults.start.toISOString(),
        endsAt: defaults.end.toISOString(),
        allDay: defaults.allDay,
        timeZone: tz,
      });
      setSummary("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover open={open} onClose={onClose} anchor={anchor} placement="right" className="w-80">
      <h3 className="mb-2 text-sm font-semibold">{t("calendar.newEvent")}</h3>
      <Input
        autoFocus
        placeholder={t("calendar.quickCreate.title")}
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
      />
      <div className="mt-2 text-[11px] text-secondary">{formatRange(defaults)}</div>
      <select
        value={calendarId}
        onChange={(e) => setCalendarId(e.target.value)}
        className="mt-2 h-8 w-full rounded-md border border-divider bg-background px-2 text-sm"
      >
        {calendars.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <div className="mt-3 flex items-center justify-between gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            onMore({
              calendarId,
              summary: summary.trim(),
              startsAt: defaults.start.toISOString(),
              endsAt: defaults.end.toISOString(),
              allDay: defaults.allDay,
            })
          }
        >
          {t("calendar.quickCreate.moreOptions")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={busy || summary.trim().length === 0}
          onClick={() => void submit()}
        >
          {t("calendar.quickCreate.create")}
        </Button>
      </div>
    </Popover>
  );
}

function formatRange(d: { start: Date; end: Date; allDay: boolean }): string {
  if (d.allDay) {
    const fmt = new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    return fmt.format(d.start);
  }
  const date = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(d.start);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${date} · ${time.format(d.start)} – ${time.format(d.end)}`;
}

// Re-export so callers can use the same util when initializing a
// `defaults.start` from a click on a day cell.
export { toLocalInput };
