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
}

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
}

export interface PatchEventArgs {
  readonly calendarId: string;
  readonly providerEventId: string;
  readonly patch: NormalizedEventPatch;
}

export interface DeleteEventArgs {
  readonly calendarId: string;
  readonly providerEventId: string;
}

export interface RespondEventArgs {
  readonly calendarId: string;
  readonly providerEventId: string;
  readonly attendeeEmail: string;
  readonly response: "accepted" | "declined" | "tentative";
  readonly comment?: string;
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
