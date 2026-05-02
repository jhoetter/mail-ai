import { useCallback, useState } from "react";
import { Card, PageBody, PageHeader, useDialogs } from "@mailai/ui";
import { PageShell } from "../components/PageShell";
import { EmptyView } from "../components/EmptyView";
import { useTranslator } from "../lib/i18n/useTranslator";
import {
  createEvent,
  deleteEvent,
  respondEvent,
  updateEvent,
  type CalendarEditScope,
  type CalendarSummary,
} from "../lib/calendar-client";
import { CalendarToolbar } from "./_components/CalendarToolbar";
import { Sidebar } from "./_components/Sidebar";
import { TimeGrid } from "./_components/TimeGrid";
import { MonthGrid } from "./_components/MonthGrid";
import { QuickCreatePopover } from "./_components/QuickCreatePopover";
import { EventDetailsPopover } from "./_components/EventDetailsPopover";
import { EventEditorDialog, type EventEditorOutput } from "./_components/EventEditorDialog";
import { startOfDay } from "./_lib/calendar-time";
import { useCalendarState, type CalendarEvent } from "./_lib/useCalendarState";

interface QuickCreateState {
  readonly anchor: HTMLElement | DOMRect;
  readonly defaults: {
    readonly calendarId: string;
    readonly start: Date;
    readonly end: Date;
    readonly allDay: boolean;
  };
}

interface DetailsState {
  readonly anchor: HTMLElement;
  readonly event: CalendarEvent;
}

interface EditorState {
  readonly intent:
    | {
        readonly mode: "create";
        readonly defaults: {
          readonly calendarId: string;
          readonly summary?: string;
          readonly start: Date;
          readonly end: Date;
          readonly allDay: boolean;
        };
      }
    | {
        readonly mode: "edit";
        readonly event: CalendarEvent;
        readonly scope: CalendarEditScope;
      };
}

export default function CalendarPage() {
  const { t } = useTranslator();
  const dialogs = useDialogs();
  const state = useCalendarState();

  const [quickCreate, setQuickCreate] = useState<QuickCreateState | null>(null);
  const [details, setDetails] = useState<DetailsState | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);

  // The first visible calendar is the "default" target for new
  // events. We intentionally keep this dumb: the picker inside the
  // popover/dialog lets the user change it before saving.
  const defaultCalendarId = state.visibleCalendars[0]?.id ?? state.calendars?.[0]?.id ?? null;

  const openCreateAt = useCallback(
    (start: Date, end: Date, allDay: boolean, anchor: HTMLElement | DOMRect) => {
      if (!defaultCalendarId) return;
      setQuickCreate({
        anchor,
        defaults: { calendarId: defaultCalendarId, start, end, allDay },
      });
    },
    [defaultCalendarId],
  );

  const onCreateButton = useCallback(() => {
    const now = new Date();
    const start = new Date(now);
    start.setMinutes(0, 0, 0);
    const end = new Date(start.getTime() + 60 * 60_000);
    openCreateAt(start, end, false, new DOMRect(window.innerWidth / 2, 80, 0, 0));
  }, [openCreateAt]);

  const calendarOf = useCallback(
    (id: string): CalendarSummary | null => state.calendars?.find((c) => c.id === id) ?? null,
    [state.calendars],
  );

  const onMoveEvent = useCallback(
    async (event: CalendarEvent, args: { start: Date; end: Date }) => {
      // Tolerate no-op drags so we don't fire a write when the user
      // grabs and drops on the same slot.
      if (
        new Date(event.startsAt).getTime() === args.start.getTime() &&
        new Date(event.endsAt).getTime() === args.end.getTime()
      ) {
        return;
      }
      try {
        await updateEvent(event.id, {
          startsAt: args.start.toISOString(),
          endsAt: args.end.toISOString(),
        });
        state.bumpRevision();
      } catch (err) {
        state.setError(err instanceof Error ? err.message : String(err));
      }
    },
    [state],
  );

  const onResizeEvent = useCallback(
    async (event: CalendarEvent, args: { start: Date; end: Date }) => {
      try {
        await updateEvent(event.id, {
          startsAt: args.start.toISOString(),
          endsAt: args.end.toISOString(),
        });
        state.bumpRevision();
      } catch (err) {
        state.setError(err instanceof Error ? err.message : String(err));
      }
    },
    [state],
  );

  const onMoveToDay = useCallback(
    async (event: CalendarEvent, day: Date) => {
      // Day-granularity move keeps the original time-of-day on the
      // new day. For all-day events both endpoints land on the day
      // boundary.
      const oldStart = new Date(event.startsAt);
      const oldEnd = new Date(event.endsAt);
      const duration = oldEnd.getTime() - oldStart.getTime();
      const newStart = new Date(day);
      if (event.allDay) {
        newStart.setHours(0, 0, 0, 0);
      } else {
        newStart.setHours(oldStart.getHours(), oldStart.getMinutes(), 0, 0);
      }
      const newEnd = new Date(newStart.getTime() + duration);
      await onMoveEvent(event, { start: newStart, end: newEnd });
    },
    [onMoveEvent],
  );

  const onSubmitEditor = useCallback(
    async (intent: NonNullable<EditorState["intent"]>, payload: EventEditorOutput) => {
      if (intent.mode === "create") {
        await createEvent({
          calendarId: payload.calendarId,
          summary: payload.summary,
          ...(payload.description ? { description: payload.description } : {}),
          ...(payload.location ? { location: payload.location } : {}),
          startsAt: payload.startsAt,
          endsAt: payload.endsAt,
          allDay: payload.allDay,
          attendees: payload.attendees.map((a) => a.email),
          meeting: payload.meeting,
          timeZone: payload.timeZone,
          ...(payload.recurrence ? { recurrence: payload.recurrence } : {}),
        });
      } else {
        await updateEvent(intent.event.id, {
          summary: payload.summary,
          description: payload.description ?? "",
          location: payload.location ?? "",
          startsAt: payload.startsAt,
          endsAt: payload.endsAt,
          allDay: payload.allDay,
          ...(payload.attendeesAdd.length > 0 ? { attendeesAdd: [...payload.attendeesAdd] } : {}),
          ...(payload.attendeesRemove.length > 0
            ? { attendeesRemove: [...payload.attendeesRemove] }
            : {}),
          meeting: payload.meeting,
          ...(payload.recurrence !== undefined ? { recurrence: payload.recurrence } : {}),
          timeZone: payload.timeZone,
          scope: intent.scope,
        });
      }
      setEditor(null);
      state.bumpRevision();
    },
    [state],
  );

  const onDeleteEvent = useCallback(
    async (event: CalendarEvent, scope: CalendarEditScope) => {
      const ok = await dialogs.confirm({
        title: t("calendar.deleteScope.title"),
        description: event.summary ? `"${event.summary}"` : undefined,
        confirmLabel: t("common.delete"),
        tone: "danger",
      });
      if (!ok) return;
      try {
        await deleteEvent(event.id, scope);
        state.bumpRevision();
        setDetails(null);
      } catch (err) {
        state.setError(err instanceof Error ? err.message : String(err));
      }
    },
    [dialogs, state, t],
  );

  return (
    <PageShell>
      <PageHeader title={t("calendar.title")} subtitle={t("calendar.subtitle")} actions={null} />
      <PageBody width="none">
        {state.error && <p className="px-4 text-sm text-error">{state.error}</p>}
        {state.calendars === null ? (
          <p className="px-4 text-sm text-secondary">{t("common.loading")}</p>
        ) : state.calendars.length === 0 ? (
          state.accounts === null ? (
            <p className="px-4 text-sm text-secondary">{t("common.loading")}</p>
          ) : state.accounts.length === 0 ? (
            <div className="flex min-h-[28rem] items-center justify-center">
              <EmptyView kind="default" hasAccounts={false} />
            </div>
          ) : (
            <CalendarEmptyState
              busy={state.busy}
              syncResult={state.syncResult}
              onSync={() => void state.onSync()}
            />
          )
        ) : (
          <div className="flex h-[calc(100vh-12rem)] min-h-[40rem] gap-3">
            <Sidebar
              cursor={state.cursor}
              onCursorChange={state.setCursor}
              calendars={state.calendars}
              onToggleCalendar={state.onToggleCalendar}
              onCreate={onCreateButton}
            />
            <div className="flex flex-1 flex-col gap-2">
              <CalendarToolbar
                view={state.view}
                cursor={state.cursor}
                busy={state.busy}
                canCreate={Boolean(defaultCalendarId)}
                onPrev={state.onPrev}
                onNext={state.onNext}
                onToday={state.onToday}
                onChangeView={state.setView}
                onSync={() => void state.onSync()}
                onCreate={onCreateButton}
              />
              {state.visibleCalendars.length === 0 ? (
                <Card>
                  <p className="text-sm text-secondary">{t("calendar.noVisibleCalendars")}</p>
                </Card>
              ) : state.view === "month" ? (
                <MonthGrid
                  cursor={state.cursor}
                  events={state.events}
                  colorForCalendar={state.colorForCalendar}
                  onCreateOnDay={(day, anchor) => {
                    const start = startOfDay(day);
                    start.setHours(9, 0, 0, 0);
                    const end = new Date(start.getTime() + 60 * 60_000);
                    openCreateAt(start, end, false, anchor);
                  }}
                  onSelectEvent={(event, anchor) => setDetails({ event, anchor })}
                  onMoveEventToDay={onMoveToDay}
                />
              ) : (
                <TimeGrid
                  view={state.view}
                  cursor={state.cursor}
                  events={state.events}
                  colorForCalendar={state.colorForCalendar}
                  onCreateRange={(args, anchor) =>
                    openCreateAt(args.start, args.end, args.allDay, anchor)
                  }
                  onSelectEvent={(event, anchor) => setDetails({ event, anchor })}
                  onMoveEvent={onMoveEvent}
                  onResizeEvent={onResizeEvent}
                />
              )}
            </div>
          </div>
        )}
      </PageBody>

      {/* Quick-create popover anchored to the drag selection. */}
      {quickCreate && state.calendars && (
        <QuickCreatePopover
          open={true}
          anchor={quickCreate.anchor}
          calendars={state.visibleCalendars}
          defaults={quickCreate.defaults}
          onClose={() => setQuickCreate(null)}
          onCreate={async (input) => {
            await createEvent({
              calendarId: input.calendarId,
              summary: input.summary,
              startsAt: input.startsAt,
              endsAt: input.endsAt,
              allDay: input.allDay,
              timeZone: input.timeZone,
            });
            setQuickCreate(null);
            state.bumpRevision();
          }}
          onMore={(input) => {
            setQuickCreate(null);
            setEditor({
              intent: {
                mode: "create",
                defaults: {
                  calendarId: input.calendarId,
                  summary: input.summary,
                  start: new Date(input.startsAt),
                  end: new Date(input.endsAt),
                  allDay: input.allDay,
                },
              },
            });
          }}
        />
      )}

      {/* Read-only details popover with RSVP / edit / delete. */}
      {details && state.calendars && (
        <EventDetailsPopover
          open={true}
          anchor={details.anchor}
          event={details.event}
          calendar={calendarOf(details.event.calendarId)}
          onClose={() => setDetails(null)}
          onRespond={async (event, response) => {
            try {
              await respondEvent({ eventId: event.id, response });
              state.bumpRevision();
            } catch (err) {
              state.setError(err instanceof Error ? err.message : String(err));
            }
          }}
          onEdit={(event, scope) => {
            setDetails(null);
            setEditor({ intent: { mode: "edit", event, scope } });
          }}
          onDelete={(event, scope) => void onDeleteEvent(event, scope)}
        />
      )}

      {/* Full editor dialog. */}
      {editor && state.calendars && (
        <EventEditorDialog
          open={true}
          intent={editor.intent}
          calendars={state.visibleCalendars}
          onClose={() => setEditor(null)}
          onSubmit={onSubmitEditor}
        />
      )}
    </PageShell>
  );
}

function CalendarEmptyState({
  busy,
  syncResult,
  onSync,
}: {
  readonly busy: boolean;
  readonly syncResult: ReturnType<typeof useCalendarState>["syncResult"];
  readonly onSync: () => void;
}) {
  const { t } = useTranslator();
  const issue = syncResult?.accounts.find((account) => account.status !== "synced") ?? null;
  return (
    <div className="flex min-h-[28rem] items-center justify-center px-4">
      <Card>
        <div className="flex max-w-lg flex-col items-center gap-3 text-center">
          <p className="text-sm font-medium text-foreground">{t("calendar.noCalendarsTitle")}</p>
          <p className="text-sm text-secondary">{t("calendar.noCalendarsHint")}</p>
          {issue ? (
            <p className="max-w-md break-words text-xs text-tertiary">
              {syncIssueMessage(issue.code, issue.message, t)}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={onSync}
              className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-sm text-on-accent hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? t("calendar.syncingCalendars") : t("calendar.syncCalendars")}
            </button>
            {issue?.code === "missing_credentials" || issue?.code === "auth_error" ? (
              <a
                href={calendarAccountsHref()}
                className="inline-flex h-8 items-center rounded-md px-3 text-sm text-secondary hover:bg-hover hover:text-foreground"
              >
                {t("emptyView.openAccounts")}
              </a>
            ) : null}
          </div>
        </div>
      </Card>
    </div>
  );
}

function syncIssueMessage(
  code: string | undefined,
  message: string | undefined,
  t: ReturnType<typeof useTranslator>["t"],
): string {
  if (code === "missing_credentials") {
    return t("calendar.syncIssues.missingCredentials");
  }
  if (code === "auth_error") {
    return t("calendar.syncIssues.authError");
  }
  if (code === "missing_adapter") {
    return t("calendar.syncIssues.missingAdapter");
  }
  return message
    ? t("calendar.syncIssues.genericWithMessage", { message })
    : t("calendar.syncIssues.generic");
}

function calendarAccountsHref(): string {
  if (typeof window === "undefined") return "/settings/account";
  return window.location.pathname === "/calendar" ? "/mail/settings/account" : "/settings/account";
}
