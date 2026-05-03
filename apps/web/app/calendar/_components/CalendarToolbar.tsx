import { Button, SegmentedControl } from "@mailai/ui";
import { ConnectionStatus } from "../../components/ConnectionStatus";
import { useTranslator } from "../../lib/i18n/useTranslator";
import type { CalendarView } from "../_lib/calendar-time";
import { startOfWeek } from "../_lib/calendar-time";

interface Props {
  readonly view: CalendarView;
  readonly cursor: Date;
  readonly busy: boolean;
  readonly canCreate: boolean;
  readonly onPrev: () => void;
  readonly onNext: () => void;
  readonly onToday: () => void;
  readonly onChangeView: (view: CalendarView) => void;
  readonly onSync: () => void;
  readonly onCreate: () => void;
}

// Title above the grid: matches Google's "April 2026" / "Apr 22 – 28,
// 2026" / "Wednesday, April 22" rendering rules. We let the browser's
// `Intl.DateTimeFormat` localize the literal text so this doesn't
// duplicate the i18n catalogue's month names.
function formatRangeLabel(view: CalendarView, cursor: Date): string {
  switch (view) {
    case "day":
      return cursor.toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      });
    case "week": {
      const start = startOfWeek(cursor);
      const end = new Date(start.getTime() + 6 * 86_400_000);
      const sameMonth = start.getMonth() === end.getMonth();
      const sameYear = start.getFullYear() === end.getFullYear();
      const startTxt = start.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        ...(sameYear ? {} : { year: "numeric" }),
      });
      const endTxt = end.toLocaleDateString(undefined, {
        month: sameMonth ? undefined : "short",
        day: "numeric",
        year: "numeric",
      });
      return `${startTxt} – ${endTxt}`;
    }
    case "month":
      return cursor.toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      });
    default: {
      const _exhaustive: never = view;
      void _exhaustive;
      return "";
    }
  }
}

export function CalendarToolbar({
  view,
  cursor,
  busy,
  canCreate,
  onPrev,
  onNext,
  onToday,
  onChangeView,
  onSync,
  onCreate,
}: Props) {
  const { t } = useTranslator();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="primary" disabled={!canCreate} onClick={onCreate}>
        {t("calendar.newEvent")}
      </Button>
      <Button size="sm" variant="ghost" onClick={onToday}>
        {t("calendar.today")}
      </Button>
      <div className="flex items-center">
        <button
          type="button"
          aria-label={t("calendar.previous")}
          onClick={onPrev}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-secondary hover:bg-hover hover:text-foreground"
        >
          ‹
        </button>
        <button
          type="button"
          aria-label={t("calendar.next")}
          onClick={onNext}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-secondary hover:bg-hover hover:text-foreground"
        >
          ›
        </button>
      </div>
      <h2 className="text-base font-semibold text-foreground">{formatRangeLabel(view, cursor)}</h2>
      <div className="ml-auto flex items-center gap-2">
        <ConnectionStatus surface="calendar" />
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={onSync}
          aria-label={t("calendar.syncCalendars")}
        >
          {t("calendar.syncCalendars")}
        </Button>
        <SegmentedControl<CalendarView>
          value={view}
          onChange={onChangeView}
          ariaLabel={t("calendar.view.day")}
          options={[
            { value: "day", label: t("calendar.view.day") },
            { value: "week", label: t("calendar.view.week") },
            { value: "month", label: t("calendar.view.month") },
          ]}
        />
      </div>
    </div>
  );
}
