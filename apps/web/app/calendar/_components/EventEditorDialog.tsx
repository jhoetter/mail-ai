import { useEffect, useMemo, useState } from "react";
import {
  Button,
  ContactPicker,
  Dialog,
  Input,
  SegmentedControl,
  type ContactPickerValue,
} from "@mailai/ui";
import { useTranslator } from "../../lib/i18n/useTranslator";
import {
  suggestContacts,
  type CalendarEditScope,
  type CalendarSummary,
  type MeetingChoice,
  type RecurrenceRule,
} from "../../lib/calendar-client";
import { detectTimeZone, toLocalInput } from "../_lib/calendar-time";
import type { CalendarEvent } from "../_lib/useCalendarState";

type RecurrencePreset = "none" | "daily" | "weekly" | "monthly" | "yearly";

interface CreateMode {
  readonly mode: "create";
  readonly defaults: {
    readonly calendarId: string;
    readonly summary?: string;
    readonly start: Date;
    readonly end: Date;
    readonly allDay: boolean;
  };
}

interface EditMode {
  readonly mode: "edit";
  readonly event: CalendarEvent;
  readonly scope: CalendarEditScope;
}

interface Props {
  readonly open: boolean;
  readonly intent: CreateMode | EditMode | null;
  readonly calendars: ReadonlyArray<CalendarSummary>;
  readonly onClose: () => void;
  readonly onSubmit: (intent: CreateMode | EditMode, payload: EventEditorOutput) => Promise<void>;
}

export interface EventEditorOutput {
  readonly calendarId: string;
  readonly summary: string;
  readonly description?: string;
  readonly location?: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly allDay: boolean;
  readonly attendees: ReadonlyArray<ContactPickerValue>;
  // Computed deltas vs. the existing event (only used in edit mode).
  readonly attendeesAdd: ReadonlyArray<string>;
  readonly attendeesRemove: ReadonlyArray<string>;
  readonly meeting: MeetingChoice;
  readonly recurrence: RecurrenceRule | null;
  readonly timeZone: string;
}

// Full editor: title, calendar, date/time + time-zone, all-day,
// location, description, attendees, conferencing, recurrence. Each
// optional UI section is gated off the selected calendar's
// capability flags so adapters that don't support a feature simply
// hide it instead of rejecting the command server-side.
export function EventEditorDialog({ open, intent, calendars, onClose, onSubmit }: Props) {
  const { t } = useTranslator();
  const initial = useMemo(() => intentToForm(intent), [intent]);

  const [calendarId, setCalendarId] = useState(initial.calendarId);
  const [summary, setSummary] = useState(initial.summary);
  const [description, setDescription] = useState(initial.description);
  const [location, setLocation] = useState(initial.location);
  const [allDay, setAllDay] = useState(initial.allDay);
  const [startsAt, setStartsAt] = useState(initial.startsAt);
  const [endsAt, setEndsAt] = useState(initial.endsAt);
  const [attendees, setAttendees] = useState<ReadonlyArray<ContactPickerValue>>(initial.attendees);
  const [meeting, setMeeting] = useState<MeetingChoice>(initial.meeting);
  const [preset, setPreset] = useState<RecurrencePreset>(initial.preset);
  const [timeZone, setTimeZone] = useState(initial.timeZone);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Re-seed when the dialog target changes.
  useEffect(() => {
    setCalendarId(initial.calendarId);
    setSummary(initial.summary);
    setDescription(initial.description);
    setLocation(initial.location);
    setAllDay(initial.allDay);
    setStartsAt(initial.startsAt);
    setEndsAt(initial.endsAt);
    setAttendees(initial.attendees);
    setMeeting(initial.meeting);
    setPreset(initial.preset);
    setTimeZone(initial.timeZone);
    setErr(null);
  }, [initial]);

  const selectedCalendar = calendars.find((c) => c.id === calendarId);
  const caps = selectedCalendar?.capabilities;
  const supportsGmeet = caps?.conferences.includes("google") ?? false;
  const supportsTeams = caps?.conferences.includes("microsoft") ?? false;
  const supportsRecurrence = caps?.recurrence ?? false;
  const supportsTimeZones = caps?.timeZones ?? false;
  const supportsAttendeePatch = caps?.patchAttendees ?? false;

  // If the new calendar doesn't honor the previously-chosen
  // conference type, downgrade to "none" so the server doesn't reject.
  useEffect(() => {
    if (meeting === "gmeet" && !supportsGmeet) setMeeting("none");
    else if (meeting === "teams" && !supportsTeams) setMeeting("none");
  }, [meeting, supportsGmeet, supportsTeams]);

  // Same for recurrence: if the calendar can't store one, force "none".
  useEffect(() => {
    if (!supportsRecurrence && preset !== "none") setPreset("none");
  }, [supportsRecurrence, preset]);

  if (!open || !intent) return null;
  const isEdit = intent.mode === "edit";
  const original = intent.mode === "edit" ? intent.event : null;

  const submit = async () => {
    if (summary.trim().length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      const start = allDay ? new Date(startsAt) : new Date(startsAt);
      const end = allDay ? new Date(endsAt) : new Date(endsAt);
      const recurrence = presetToRecurrence(preset, start);

      const originalEmails = new Set((original?.attendees ?? []).map((a) => a.email.toLowerCase()));
      const currentEmails = new Set(attendees.map((a) => a.email.toLowerCase()));
      const attendeesAdd = supportsAttendeePatch
        ? attendees.filter((a) => !originalEmails.has(a.email.toLowerCase())).map((a) => a.email)
        : [];
      const attendeesRemove = supportsAttendeePatch
        ? Array.from(originalEmails).filter((e) => !currentEmails.has(e))
        : [];

      await onSubmit(intent, {
        calendarId,
        summary: summary.trim(),
        ...(description ? { description } : {}),
        ...(location ? { location } : {}),
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        allDay,
        attendees,
        attendeesAdd,
        attendeesRemove,
        meeting,
        recurrence,
        timeZone,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose}>
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold">
          {isEdit ? t("calendar.editEvent") : t("calendar.newEvent")}
        </h3>
        <button
          type="button"
          aria-label={t("common.close")}
          onClick={onClose}
          className="text-secondary hover:text-foreground"
        >
          ×
        </button>
      </div>

      <div className="mt-3 grid gap-3">
        <Input
          autoFocus
          placeholder={t("calendar.eventTitle")}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs text-secondary">
            {t("calendar.eventStart")}
            <input
              type={allDay ? "date" : "datetime-local"}
              value={trimToType(startsAt, allDay)}
              onChange={(e) => setStartsAt(e.target.value)}
              className="h-9 rounded-md border border-divider bg-background px-2 text-sm text-foreground"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-secondary">
            {t("calendar.eventEnd")}
            <input
              type={allDay ? "date" : "datetime-local"}
              value={trimToType(endsAt, allDay)}
              onChange={(e) => setEndsAt(e.target.value)}
              className="h-9 rounded-md border border-divider bg-background px-2 text-sm text-foreground"
            />
          </label>
        </div>

        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
            {t("calendar.allDay")}
          </label>
          {supportsTimeZones && !allDay && (
            <label className="flex flex-1 items-center gap-2 text-xs text-secondary">
              <span>{t("calendar.timeZone")}</span>
              <Input
                value={timeZone}
                onChange={(e) => setTimeZone(e.target.value)}
                className="flex-1"
              />
            </label>
          )}
        </div>

        <select
          value={calendarId}
          onChange={(e) => setCalendarId(e.target.value)}
          className="h-9 rounded-md border border-divider bg-background px-2 text-sm"
        >
          {calendars.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        <Input
          placeholder={t("calendar.eventLocation")}
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        />

        <textarea
          className="min-h-24 w-full rounded-md border border-divider bg-background p-2 text-sm"
          placeholder={t("calendar.eventDescription")}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />

        <div className="flex flex-col gap-1">
          <span className="text-xs text-secondary">{t("calendar.eventAttendees")}</span>
          <ContactPicker
            value={attendees}
            onChange={(v) => setAttendees(v)}
            onSearch={async (q) => {
              const items = await suggestContacts(q);
              return items;
            }}
            placeholder={t("calendar.eventAttendees")}
          />
        </div>

        {(supportsGmeet || supportsTeams) && (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-secondary">{t("calendar.meeting")}</span>
            <select
              value={meeting}
              onChange={(e) => setMeeting(e.target.value as MeetingChoice)}
              className="h-9 rounded-md border border-divider bg-background px-2 text-sm"
            >
              <option value="none">{t("calendar.meetingNone")}</option>
              <option value="gmeet" disabled={!supportsGmeet}>
                {t("calendar.meetingGmeet")}
              </option>
              <option value="teams" disabled={!supportsTeams}>
                {t("calendar.meetingTeams")}
              </option>
            </select>
          </div>
        )}

        {supportsRecurrence && (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-secondary">{t("calendar.recurrence.label")}</span>
            <SegmentedControl<RecurrencePreset>
              value={preset}
              onChange={setPreset}
              size="sm"
              options={[
                { value: "none", label: t("calendar.recurrence.none") },
                { value: "daily", label: t("calendar.recurrence.daily") },
                { value: "weekly", label: t("calendar.recurrence.weekly") },
                { value: "monthly", label: t("calendar.recurrence.monthly") },
                { value: "yearly", label: t("calendar.recurrence.yearly") },
              ]}
            />
          </div>
        )}

        {err && <p className="text-xs text-error">{err}</p>}
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy || summary.trim().length === 0}
            onClick={() => void submit()}
          >
            {busy ? t("calendar.saving") : t("common.save")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function intentToForm(intent: CreateMode | EditMode | null) {
  const tz = detectTimeZone();
  if (!intent) {
    const now = new Date();
    return {
      calendarId: "",
      summary: "",
      description: "",
      location: "",
      allDay: false,
      startsAt: toLocalInput(now),
      endsAt: toLocalInput(new Date(now.getTime() + 60 * 60_000)),
      attendees: [] as ReadonlyArray<ContactPickerValue>,
      meeting: "none" as MeetingChoice,
      preset: "none" as RecurrencePreset,
      timeZone: tz,
    };
  }
  if (intent.mode === "create") {
    return {
      calendarId: intent.defaults.calendarId,
      summary: intent.defaults.summary ?? "",
      description: "",
      location: "",
      allDay: intent.defaults.allDay,
      startsAt: toLocalInput(intent.defaults.start),
      endsAt: toLocalInput(intent.defaults.end),
      attendees: [] as ReadonlyArray<ContactPickerValue>,
      meeting: "none" as MeetingChoice,
      preset: "none" as RecurrencePreset,
      timeZone: tz,
    };
  }
  const ev = intent.event;
  return {
    calendarId: ev.calendarId,
    summary: ev.summary ?? "",
    description: ev.description ?? "",
    location: ev.location ?? "",
    allDay: ev.allDay,
    startsAt: toLocalInput(new Date(ev.startsAt)),
    endsAt: toLocalInput(new Date(ev.endsAt)),
    attendees: (ev.attendees ?? []).map<ContactPickerValue>((a) => ({
      email: a.email,
      ...(a.name ? { name: a.name } : {}),
      ...(a.organizer ? { organizer: true } : {}),
      ...(a.response ? { response: a.response } : {}),
    })),
    meeting: (ev.meetingProvider === "google-meet"
      ? "gmeet"
      : ev.meetingProvider === "ms-teams"
        ? "teams"
        : "none") as MeetingChoice,
    preset: "none" as RecurrencePreset,
    timeZone: tz,
  };
}

// Convert a `<input type="datetime-local">` value to a `<input
// type="date">` value when the user toggles all-day, and back the
// other way. Without this the inputs would silently keep their
// previous value and re-render with garbage.
function trimToType(value: string, allDay: boolean): string {
  if (allDay) return value.slice(0, 10);
  if (value.length === 10) return `${value}T09:00`;
  return value;
}

function presetToRecurrence(preset: RecurrencePreset, start: Date): RecurrenceRule | null {
  switch (preset) {
    case "none":
      return null;
    case "daily":
      return { freq: "DAILY", interval: 1 };
    case "weekly": {
      // Anchor BYDAY to the start date's weekday so "weekly" means
      // "every <Monday>" rather than "every 7 days".
      const days = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
      const day = days[start.getDay()]!;
      return { freq: "WEEKLY", interval: 1, byday: [day] };
    }
    case "monthly":
      return { freq: "MONTHLY", interval: 1, bymonthday: [start.getDate()] };
    case "yearly":
      return { freq: "YEARLY", interval: 1 };
    default: {
      const _exhaustive: never = preset;
      void _exhaustive;
      return null;
    }
  }
}
