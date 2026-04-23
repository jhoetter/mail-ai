// CalendarProvider — provider-neutral port for calendar reads +
// writes. Mirrors MailProvider in shape: stateless, access-token
// in, normalized data out, capabilities expressed in a small flag
// bag so callers can gate UI without instanceof checks.
//
// Only the behaviours the Phase 8 calendar refactor actually
// invokes are on the port; future grow-in (free/busy, recurring
// edits, attachments) extends here so adapters keep the same
// shape.

import type { MailProviderId } from "../types.js";
import type { AccessTokenArgs } from "../mail/port.js";
import type {
  CreateEventArgs,
  CreatedEvent,
  DeleteEventArgs,
  EventEditScope,
  EventMetadata,
  ListEventsArgs,
  NormalizedCalendar,
  NormalizedEvent,
  PatchEventArgs,
  RespondEventArgs,
} from "./types.js";

export interface CalendarProviderCapabilities {
  // Whether this adapter can run the create/patch/delete/respond
  // mutation surface at all. False adapters get hidden from the
  // composer — currently both Google and Microsoft return true.
  readonly mutate: boolean;
  // Conference types the adapter can provision. `null` is always
  // implicit (no conference). The web UI uses this to filter the
  // "Add video meeting" picker so a Microsoft account never offers
  // Google Meet.
  readonly conferences: ReadonlyArray<"google" | "microsoft">;
  // Whether respondEvent translates "tentative" semantics 1:1.
  // Both implemented adapters return true; left here so a future
  // CalDAV adapter can flag the limitation.
  readonly respondTentative: boolean;
  // Whether the adapter can create + edit recurring series via a
  // RecurrenceRule on createEvent / patchEvent.
  readonly recurrence: boolean;
  // Edit scopes the adapter advertises. The web UI hides scopes
  // missing from this list (eg. an adapter without "following"
  // splits the radio group down to single + series).
  readonly editScopes: ReadonlyArray<EventEditScope>;
  // Whether patchEvent honors `attendeesAdd` / `attendeesRemove`.
  // Adapters without this raise on a patch that touches attendees,
  // so the UI keeps the chip input read-only.
  readonly patchAttendees: boolean;
  // Whether createEvent / patchEvent honor `timeZone`. When false,
  // the UI omits the time-zone picker and adapters fall back to
  // UTC instants.
  readonly timeZones: boolean;
}

export interface CalendarProvider {
  readonly id: MailProviderId;
  readonly capabilities: CalendarProviderCapabilities;

  listCalendars(args: AccessTokenArgs): Promise<ReadonlyArray<NormalizedCalendar>>;

  listEvents(args: AccessTokenArgs & ListEventsArgs): Promise<ReadonlyArray<NormalizedEvent>>;

  // Returns metadata needed by the iMIP composer (icalUid, current
  // SEQUENCE, conference URL). Adapters for providers that don't
  // expose SEQUENCE return 0 — the calendar repository keeps a
  // local counter we increment on every update.
  getEvent(
    args: AccessTokenArgs & {
      calendarId: string;
      providerEventId: string;
    },
  ): Promise<EventMetadata>;

  createEvent(args: AccessTokenArgs & CreateEventArgs): Promise<CreatedEvent>;

  patchEvent(args: AccessTokenArgs & PatchEventArgs): Promise<void>;

  deleteEvent(args: AccessTokenArgs & DeleteEventArgs): Promise<void>;

  respondEvent(args: AccessTokenArgs & RespondEventArgs): Promise<void>;
}
