import { useState } from "react";
import { Button, Popover, SegmentedControl } from "@mailai/ui";
import { useTranslator } from "../../lib/i18n/useTranslator";
import type {
  CalendarEditScope,
  CalendarSummary,
} from "../../lib/calendar-client";
import type { CalendarEvent } from "../_lib/useCalendarState";

type RsvpResponse = "accepted" | "declined" | "tentative";

interface Props {
  readonly open: boolean;
  readonly anchor: HTMLElement | DOMRect | null;
  readonly event: CalendarEvent | null;
  readonly calendar: CalendarSummary | null;
  readonly onClose: () => void;
  readonly onEdit: (event: CalendarEvent, scope: CalendarEditScope) => void;
  readonly onDelete: (event: CalendarEvent, scope: CalendarEditScope) => void;
  readonly onRespond: (
    event: CalendarEvent,
    response: RsvpResponse,
  ) => Promise<void> | void;
}

// Google's read-view popover: shows the event meta, attendee list,
// join meeting button and RSVP segmented control. When the event is
// recurring, Edit/Delete first ask the user via a SegmentedControl
// whether the action should target this/following/series — the
// scopes that show up come from the calendar's adapter capabilities.
export function EventDetailsPopover({
  open,
  anchor,
  event,
  calendar,
  onClose,
  onEdit,
  onDelete,
  onRespond,
}: Props) {
  const { t } = useTranslator();
  const [scopePrompt, setScopePrompt] = useState<"edit" | "delete" | null>(null);
  const [scope, setScope] = useState<CalendarEditScope>("single");

  if (!event) {
    return (
      <Popover open={open} onClose={onClose} anchor={anchor} placement="right">
        {null}
      </Popover>
    );
  }

  const editScopes = calendar?.capabilities.editScopes ?? ["single"];
  const recurring = Boolean(
    (event as { recurringEventId?: string | null }).recurringEventId ??
      (event as { recurrenceRule?: string | null }).recurrenceRule,
  );

  const start = new Date(event.startsAt);
  const end = new Date(event.endsAt);

  return (
    <Popover open={open} onClose={onClose} anchor={anchor} placement="right" className="w-96">
      <header className="flex items-start gap-2">
        <span
          className="mt-1 inline-block h-3 w-3 shrink-0 rounded-sm"
          style={{ backgroundColor: calendar?.color ?? "#94a3b8" }}
        />
        <div className="flex-1">
          <h3 className="text-sm font-semibold leading-tight">
            {event.summary || "(no title)"}
          </h3>
          <p className="mt-0.5 text-xs text-secondary">{formatRange(start, end, event.allDay)}</p>
          {calendar && (
            <p className="mt-0.5 text-[11px] text-tertiary">{calendar.name}</p>
          )}
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="text-secondary hover:text-foreground"
        >
          ×
        </button>
      </header>

      {event.location && (
        <p className="mt-3 text-sm text-secondary">📍 {event.location}</p>
      )}
      {event.description && (
        <p
          className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap text-sm text-foreground"
          dangerouslySetInnerHTML={{ __html: event.description }}
        />
      )}

      {event.meetingJoinUrl && (
        <a
          href={event.meetingJoinUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-3 inline-flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:brightness-110"
        >
          {event.meetingProvider === "ms-teams"
            ? t("calendar.joinTeams")
            : t("calendar.joinMeet")}
        </a>
      )}

      {event.attendees && event.attendees.length > 0 && (
        <section className="mt-3">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-secondary">
            {t("calendar.guests")}
          </h4>
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {event.attendees.map((a) => (
              <li key={a.email} className="flex items-center gap-2">
                <ResponseDot {...(a.response ? { response: a.response } : {})} />
                <span className="flex-1 truncate">{a.name ?? a.email}</span>
                {a.organizer && (
                  <span className="text-[10px] uppercase text-tertiary">
                    {t("calendar.organizer")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-3">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-secondary">
          {t("calendar.yourResponse")}
        </h4>
        <div className="mt-1">
          <SegmentedControl<RsvpResponse>
            value={(event.responseStatus as RsvpResponse) || "accepted"}
            onChange={(r) => void onRespond(event, r)}
            ariaLabel={t("calendar.yourResponse")}
            options={[
              { value: "accepted", label: t("calendar.accept") },
              { value: "tentative", label: t("calendar.tentative") },
              { value: "declined", label: t("calendar.decline") },
            ]}
          />
        </div>
      </section>

      {scopePrompt && recurring && editScopes.length > 1 ? (
        <section className="mt-4 rounded-md border border-divider bg-background/40 p-2">
          <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-secondary">
            {scopePrompt === "edit"
              ? t("calendar.editScope.title")
              : t("calendar.deleteScope.title")}
          </h4>
          <SegmentedControl<CalendarEditScope>
            value={scope}
            onChange={setScope}
            options={editScopes.map((s) => ({
              value: s,
              label: t(`calendar.editScope.${s}`),
            }))}
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setScopePrompt(null)}>
              {/* No dedicated "cancel" key for this submenu; reuse common.cancel. */}
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              variant={scopePrompt === "delete" ? "ghost" : "primary"}
              onClick={() => {
                if (scopePrompt === "edit") onEdit(event, scope);
                else onDelete(event, scope);
                setScopePrompt(null);
              }}
            >
              {scopePrompt === "edit" ? t("calendar.editEvent") : t("common.delete")}
            </Button>
          </div>
        </section>
      ) : (
        <div className="mt-4 flex justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (recurring && editScopes.length > 1) setScopePrompt("delete");
              else onDelete(event, "single");
            }}
          >
            {t("common.delete")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              if (recurring && editScopes.length > 1) setScopePrompt("edit");
              else onEdit(event, "single");
            }}
          >
            {t("calendar.editEvent")}
          </Button>
        </div>
      )}
    </Popover>
  );
}

function formatRange(start: Date, end: Date, allDay: boolean): string {
  if (allDay) {
    const fmt = new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
    return fmt.format(start);
  }
  const date = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(start);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${date} · ${time.format(start)} – ${time.format(end)}`;
}

function ResponseDot({ response }: { response?: string }) {
  if (!response || response === "needsAction") {
    return <span className="inline-block h-2 w-2 rounded-full bg-divider" />;
  }
  const cls =
    response === "accepted"
      ? "bg-success"
      : response === "declined"
        ? "bg-error"
        : "bg-warning";
  return <span className={"inline-block h-2 w-2 rounded-full " + cls} />;
}
