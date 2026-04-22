// RFC 5545 (iCalendar) + RFC 5546 (iTIP) emitter.
//
// We only emit; parsing inbound .ics is a separate concern handled by
// the IMAP ingestion path. Scope here is narrow on purpose:
//
//   - single-occurrence VEVENT (no RRULE / EXDATE / VTIMEZONE blocks)
//   - METHOD:REQUEST  → invite + updates
//   - METHOD:CANCEL   → cancellation (organizer → attendees)
//   - METHOD:REPLY    → RSVP (attendee → organizer); single ATTENDEE line
//
// We carry conferencing links as both standard `URL:` and well-known
// X-properties so Apple Mail / Outlook desktop / Gmail render the
// "Join" button regardless of which property they sniff.

export type IcsMethod = "REQUEST" | "CANCEL" | "REPLY";

export type IcsPartstat =
  | "ACCEPTED"
  | "DECLINED"
  | "TENTATIVE"
  | "NEEDS-ACTION";

export type IcsRole = "REQ-PARTICIPANT" | "OPT-PARTICIPANT";

export interface IcsAttendee {
  readonly email: string;
  readonly name?: string;
  readonly partstat?: IcsPartstat;
  readonly role?: IcsRole;
  readonly rsvp?: boolean;
}

export interface IcsOrganizer {
  readonly email: string;
  readonly name?: string;
}

export interface IcsConference {
  readonly provider: "google-meet" | "ms-teams";
  readonly joinUrl: string;
}

export interface IcsEvent {
  readonly uid: string;
  readonly sequence: number;
  readonly dtstamp: Date;
  readonly dtstart: Date;
  readonly dtend: Date;
  readonly allDay?: boolean;
  readonly summary: string;
  readonly description?: string;
  readonly location?: string;
  readonly url?: string;
  readonly organizer: IcsOrganizer;
  readonly attendees: readonly IcsAttendee[];
  readonly conference?: IcsConference;
  readonly status?: "CONFIRMED" | "CANCELLED";
}

export interface ComposedIcs {
  readonly body: string;
  readonly contentType: string;
}

const PRODID = "-//mail-ai//calendar 1.0//EN";

export function composeIcs(event: IcsEvent, method: IcsMethod): ComposedIcs {
  const lines: string[] = [];
  lines.push("BEGIN:VCALENDAR");
  lines.push(`PRODID:${PRODID}`);
  lines.push("VERSION:2.0");
  lines.push("CALSCALE:GREGORIAN");
  lines.push(`METHOD:${method}`);
  lines.push("BEGIN:VEVENT");
  lines.push(`UID:${escapeText(event.uid)}`);
  lines.push(`DTSTAMP:${formatUtc(event.dtstamp)}`);
  lines.push(`SEQUENCE:${event.sequence}`);
  if (event.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${formatDate(event.dtstart)}`);
    lines.push(`DTEND;VALUE=DATE:${formatDate(event.dtend)}`);
  } else {
    lines.push(`DTSTART:${formatUtc(event.dtstart)}`);
    lines.push(`DTEND:${formatUtc(event.dtend)}`);
  }
  lines.push(`SUMMARY:${escapeText(event.summary)}`);
  if (event.description) {
    lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  }
  if (event.location) {
    lines.push(`LOCATION:${escapeText(event.location)}`);
  }
  if (event.url) {
    lines.push(`URL:${event.url}`);
  }
  // Status: explicit override wins; otherwise derive from method.
  const status =
    event.status ?? (method === "CANCEL" ? "CANCELLED" : "CONFIRMED");
  lines.push(`STATUS:${status}`);

  // ORGANIZER is mandatory for METHOD-bearing iTIP messages.
  lines.push(buildOrganizer(event.organizer));

  if (method === "REPLY") {
    // RFC 5546: the REPLY contains exactly one ATTENDEE — the one
    // sending the response. The handler must pre-filter `attendees`
    // down to that single entry.
    for (const a of event.attendees) {
      lines.push(buildAttendee(a));
    }
  } else {
    for (const a of event.attendees) {
      lines.push(buildAttendee(a));
    }
  }

  if (event.conference) {
    if (event.conference.provider === "google-meet") {
      // Google's interoperable hint: include both the bare X-property
      // and the structured CONFERENCE-DATA-style URL block. The latter
      // is what Google Calendar's own export uses.
      lines.push(`X-GOOGLE-CONFERENCE:${event.conference.joinUrl}`);
    } else if (event.conference.provider === "ms-teams") {
      lines.push(
        `X-MICROSOFT-SKYPETEAMSMEETINGURL:${event.conference.joinUrl}`,
      );
      lines.push(
        `X-MICROSOFT-ONLINEMEETINGCONFLINK:${event.conference.joinUrl}`,
      );
    }
  }

  lines.push("END:VEVENT");
  lines.push("END:VCALENDAR");

  const folded = lines.map(foldLine).join("\r\n") + "\r\n";
  return {
    body: folded,
    contentType: `text/calendar; charset=UTF-8; method=${method}`,
  };
}

function buildOrganizer(org: IcsOrganizer): string {
  const params: string[] = [];
  if (org.name) params.push(`CN=${quoteIfNeeded(org.name)}`);
  const head = params.length > 0 ? `ORGANIZER;${params.join(";")}` : "ORGANIZER";
  return `${head}:mailto:${org.email}`;
}

function buildAttendee(a: IcsAttendee): string {
  const params: string[] = [];
  if (a.name) params.push(`CN=${quoteIfNeeded(a.name)}`);
  params.push(`ROLE=${a.role ?? "REQ-PARTICIPANT"}`);
  params.push(`PARTSTAT=${a.partstat ?? "NEEDS-ACTION"}`);
  if (a.rsvp !== false) params.push("RSVP=TRUE");
  return `ATTENDEE;${params.join(";")}:mailto:${a.email}`;
}

// RFC 5545 §3.3.11 TEXT escaping.
function escapeText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

// CN values are quoted when they contain `:`, `;`, `,` or whitespace.
function quoteIfNeeded(s: string): string {
  if (/[:;,"\s]/.test(s)) return `"${s.replace(/"/g, "")}"`;
  return s;
}

// RFC 5545 §3.1: line folding at 75 octets, continuation lines start
// with a single space. We measure in UTF-8 byte length so multi-byte
// characters don't push us past the limit.
function foldLine(line: string): string {
  const max = 75;
  const buf = Buffer.from(line, "utf8");
  if (buf.length <= max) return line;
  const out: string[] = [];
  let offset = 0;
  let first = true;
  while (offset < buf.length) {
    const chunkLen = first ? max : max - 1; // continuation line "owes" a leading space
    const end = Math.min(offset + chunkLen, buf.length);
    // Avoid splitting in the middle of a multi-byte sequence: walk back
    // until we're on a continuation byte boundary.
    let safeEnd = end;
    while (safeEnd > offset && safeEnd < buf.length) {
      const b = buf[safeEnd]!;
      if ((b & 0xc0) !== 0x80) break;
      safeEnd -= 1;
    }
    const chunk = buf.slice(offset, safeEnd).toString("utf8");
    out.push(first ? chunk : ` ${chunk}`);
    offset = safeEnd;
    first = false;
  }
  return out.join("\r\n");
}

// Format a Date as iCal UTC: YYYYMMDDTHHMMSSZ.
function formatUtc(d: Date): string {
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  const hh = d.getUTCHours().toString().padStart(2, "0");
  const mi = d.getUTCMinutes().toString().padStart(2, "0");
  const ss = d.getUTCSeconds().toString().padStart(2, "0");
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
}

// Format a Date as iCal DATE (all-day): YYYYMMDD, in UTC.
function formatDate(d: Date): string {
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}
