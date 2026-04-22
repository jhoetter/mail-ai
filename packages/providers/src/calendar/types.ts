// Calendar-shaped normalized types. Mirrors the shapes already
// living in @mailai/oauth-tokens/calendar but pulled into the
// providers package so handlers can hold a CalendarProvider
// reference without importing concrete adapter code.

export interface NormalizedCalendar {
  readonly providerCalendarId: string;
  readonly name: string;
  readonly color: string | null;
  readonly isPrimary: boolean;
}

export interface NormalizedAttendee {
  readonly email: string;
  readonly name?: string;
  readonly response?: "accepted" | "declined" | "tentative" | "needsAction";
  readonly organizer?: boolean;
}

// RFC 5545 RRULE expressed as a small structured object so adapters
// can serialize it however the upstream API wants:
//   - Google wants a literal `RRULE:FREQ=WEEKLY;BYDAY=MO` string array.
//   - Microsoft Graph wants a `{ pattern, range }` object.
// Keep this subset narrow on purpose — common Google Calendar UI
// affordances (daily/weekly/monthly/yearly + "every N", "until date",
// "after N occurrences", "on Mon/Wed/Fri") all serialize cleanly out
// of these fields. Custom rules round-trip through `raw` on the
// originating event.
export interface RecurrenceRule {
  readonly freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  readonly interval?: number;
  readonly count?: number;
  readonly until?: Date;
  // Two-letter weekday codes per RFC 5545 (`MO`, `TU`, …, `SU`).
  readonly byday?: ReadonlyArray<"MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU">;
  readonly bymonthday?: ReadonlyArray<number>;
}

export interface NormalizedEvent {
  readonly providerEventId: string;
  readonly icalUid: string | null;
  readonly summary: string | null;
  readonly description: string | null;
  readonly location: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly allDay: boolean;
  readonly attendees: ReadonlyArray<NormalizedAttendee>;
  readonly organizerEmail: string | null;
  readonly responseStatus: string | null;
  readonly status: string | null;
  // For instances of a recurring series, points at the master event's
  // provider id. Always null for one-off events. Drives the
  // "this / following / all" picker on edit/delete.
  readonly recurringEventId: string | null;
  // The serialized RRULE string from the master event (when this is
  // the master) or null. Useful for the editor to show "Repeats
  // weekly on Tuesday" without re-fetching.
  readonly recurrenceRule: string | null;
  // Provider-specific raw payload kept for diagnostics + the few
  // places that need fields the normalized shape doesn't expose.
  readonly raw: unknown;
}

// Result of the "we just created/updated an event upstream" flow.
// providerEventId is the authoritative id we persist; icalUid lets
// the iMIP envelope our handlers send out address the same event.
export interface CreatedEvent {
  readonly providerEventId: string;
  readonly icalUid: string;
  readonly joinUrl: string | null;
  readonly sequence: number;
}

// Conferencing types we know how to ask the provider to provision.
// google = Google Meet, microsoft = Teams. `null` means "no
// conference link, leave the event without one".
export type ConferenceProvider = "google" | "microsoft" | null;

export interface CreateEventArgs {
  readonly calendarId: string;
  readonly summary: string;
  readonly description?: string;
  readonly location?: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly allDay?: boolean;
  readonly attendees?: ReadonlyArray<string>;
  // null = no conference; "google"|"microsoft" = ask the provider
  // to mint one. The MailProviderId already pins which adapter is
  // routing the call, so an Outlook adapter rejects {conference:"google"}
  // with a clear error rather than silently doing nothing.
  readonly conference?: ConferenceProvider;
  // IANA zone id (`Europe/Berlin`, `America/New_York`). Adapters
  // that advertise capabilities.timeZones=true will store starts/ends
  // floating in this zone; adapters without zone support persist the
  // UTC instants and ignore this hint.
  readonly timeZone?: string;
  // Optional recurrence to make the new event a series master.
  readonly recurrence?: RecurrenceRule;
}

// Edit scopes for events that belong to a series. `single` patches
// just the clicked instance; `following` splits the series at the
// instance and creates a new series for the tail; `series` patches
// the master and so propagates to every instance. Adapters expose
// the subset they can implement via capabilities.editScopes.
export type EventEditScope = "single" | "following" | "series";

// Normalized partial-update for an existing event. Every field is
// optional — adapters apply only those that are set, and translate
// into provider-specific bodies (Google `summary`/`start.dateTime`
// vs Graph `subject`/`start.dateTime+timeZone`). Keeps the handler
// layer free of provider-shape branching.
export interface NormalizedEventPatch {
  readonly summary?: string;
  readonly description?: string;
  readonly location?: string;
  readonly startsAt?: Date;
  readonly endsAt?: Date;
  readonly allDay?: boolean;
  // Attendee deltas. Adapters that advertise
  // capabilities.patchAttendees=true read the existing attendee list
  // off the event, add `attendeesAdd`, and remove `attendeesRemove`,
  // then write back the merged set. Adapters without the capability
  // throw rather than silently dropping the change.
  readonly attendeesAdd?: ReadonlyArray<string>;
  readonly attendeesRemove?: ReadonlyArray<string>;
  // null clears the recurrence (turns a series into a single event);
  // a RecurrenceRule replaces it.
  readonly recurrence?: RecurrenceRule | null;
  readonly timeZone?: string;
}

export interface PatchEventArgs {
  readonly calendarId: string;
  readonly providerEventId: string;
  readonly patch: NormalizedEventPatch;
  // Only meaningful for events that belong to a series. Adapters
  // that don't list a scope in capabilities.editScopes throw when
  // it's passed.
  readonly scope?: EventEditScope;
}

export interface DeleteEventArgs {
  readonly calendarId: string;
  readonly providerEventId: string;
  readonly scope?: EventEditScope;
}

export interface RespondEventArgs {
  readonly calendarId: string;
  readonly providerEventId: string;
  readonly attendeeEmail: string;
  readonly response: "accepted" | "declined" | "tentative";
  readonly comment?: string;
  readonly scope?: EventEditScope;
}

export interface ListEventsArgs {
  readonly calendarId: string;
  readonly timeMin: Date;
  readonly timeMax: Date;
}

// Returned by getEvent — the parts the iMIP composer needs to issue
// an update or cancel without a second round-trip.
export interface EventMetadata {
  readonly icalUid: string;
  readonly sequence: number;
  readonly joinUrl: string | null;
}
