// Wraps node-ical with a stable ParsedInvite shape for mail-ai UI + API.

import ical from "node-ical";
import type { Attendee, CalendarResponse, Organizer, VEvent } from "node-ical";

export interface ParsedInviteAttendee {
  readonly email: string;
  readonly name?: string;
  readonly partstat?: string;
  readonly rsvp?: boolean;
  readonly organizer?: boolean;
}

/**
 * Conferencing platform inferred from the meeting URL or X-* property.
 * `other` means a plausible https URL was found but it didn't match a known
 * provider; null means no URL was discovered at all.
 */
export type ParsedInviteMeetingProvider =
  | "google-meet"
  | "ms-teams"
  | "zoom"
  | "webex"
  | "gotomeeting"
  | "other";

/** One VEVENT worth showing as a meeting invite / update / cancel. */
export interface ParsedInvite {
  readonly uid: string;
  readonly sequence: number;
  /** METHOD from VCALENDAR (or VEVENT fallback). */
  readonly method: string | null;
  readonly summary: string;
  readonly description?: string;
  readonly location?: string;
  readonly organizerEmail: string | null;
  readonly organizerName?: string;
  readonly attendees: ParsedInviteAttendee[];
  readonly start: Date;
  readonly end: Date;
  readonly allDay: boolean;
  readonly isCancellation: boolean;
  readonly rrule?: string | null;
  /** First conference URL found in URL / LOCATION / X-* / DESCRIPTION. */
  readonly meetingUrl?: string | null;
  /** Inferred provider for the URL above, when one is recognised. */
  readonly meetingProvider?: ParsedInviteMeetingProvider | null;
}

function stripMailto(val: string): string {
  const v = val.trim();
  if (v.toLowerCase().startsWith("mailto:")) return v.slice(7).split("?")[0] ?? v;
  return v.split("?")[0] ?? v;
}

function organizerFromProp(org: Organizer | undefined): { email: string | null; name?: string } {
  if (org === undefined || org === null) return { email: null };
  if (typeof org === "string") return { email: stripMailto(org) || null };
  const val = typeof org.val === "string" ? org.val : "";
  const email = stripMailto(val) || null;
  const cn = org.params?.CN;
  const name = typeof cn === "string" ? cn : undefined;
  return { email, ...(name ? { name } : {}) };
}

function attendeeFromProp(
  a: Attendee,
): { email: string; name?: string; partstat?: string; rsvp?: boolean; organizer?: boolean } | null {
  if (a === undefined || a === null) return null;
  const raw = typeof a === "string" ? a : a.val;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const email = stripMailto(raw);
  if (!email) return null;
  const params = typeof a === "object" && a && "params" in a ? a.params : undefined;
  const name = params && typeof params.CN === "string" ? params.CN : undefined;
  const partstat =
    params && typeof params.PARTSTAT === "string" ? params.PARTSTAT.toLowerCase() : undefined;
  const rsvp = params && typeof params.RSVP === "boolean" ? params.RSVP : undefined;
  const organizer = params && params.ROLE === "CHAIR";
  return { email, ...(name ? { name } : {}), ...(partstat ? { partstat } : {}), ...(rsvp !== undefined ? { rsvp } : {}), ...(organizer ? { organizer: true } : {}) };
}

function collectAttendees(ev: VEvent): ParsedInviteAttendee[] {
  const raw = ev.attendee;
  if (raw === undefined) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out: ParsedInviteAttendee[] = [];
  for (const x of list) {
    const p = attendeeFromProp(x);
    if (p) out.push(p);
  }
  return out;
}

function parseSequence(seq: string | undefined): number {
  if (!seq) return 0;
  const n = Number.parseInt(seq, 10);
  return Number.isFinite(n) ? n : 0;
}

function calendarMethod(data: CalendarResponse): string | null {
  for (const k of Object.keys(data)) {
    const c = data[k];
    if (c && typeof c === "object" && "type" in c && (c as { type: string }).type === "VCALENDAR") {
      const m = (c as { method?: string }).method;
      return typeof m === "string" ? m : null;
    }
  }
  return null;
}

// Extracts a conference join URL from anywhere in a VEVENT.
//
// The lookup order matters: provider clients put the join URL in different
// places (Google → URL or X-GOOGLE-CONFERENCE; Outlook/Teams → LOCATION or
// X-MICROSOFT-SKYPETEAMSMEETINGURL; Zoom → DESCRIPTION). We always try the
// "definitely a meeting URL" sources first (URL property, X-* properties)
// before falling back to free-text scanning so we don't pick up unrelated
// links pasted into the description.
const PROVIDER_HOST_RX = new RegExp(
  [
    String.raw`zoom\.us`,
    String.raw`zoom\.com`,
    String.raw`meet\.google\.com`,
    String.raw`hangouts\.google\.com`,
    String.raw`teams\.microsoft\.com`,
    String.raw`teams\.live\.com`,
    String.raw`teams\.cloud\.microsoft`,
    String.raw`webex\.com`,
    String.raw`gotomeeting\.com`,
    String.raw`gotomeet\.me`,
  ].join("|"),
  "i",
);

const ANY_PROVIDER_URL_RX = new RegExp(
  `https?:\\/\\/[^\\s<>"']*(?:${PROVIDER_HOST_RX.source})[^\\s<>"']*`,
  "i",
);

function detectProvider(url: string): ParsedInviteMeetingProvider {
  const u = url.toLowerCase();
  if (u.includes("meet.google.com") || u.includes("hangouts.google.com")) return "google-meet";
  if (
    u.includes("teams.microsoft.com") ||
    u.includes("teams.live.com") ||
    u.includes("teams.cloud.microsoft")
  ) {
    return "ms-teams";
  }
  if (u.includes("zoom.us") || u.includes("zoom.com")) return "zoom";
  if (u.includes("webex.com")) return "webex";
  if (u.includes("gotomeeting.com") || u.includes("gotomeet.me")) return "gotomeeting";
  return "other";
}

function readXPropertyUrl(ev: VEvent, key: string): string | null {
  const bag = ev as unknown as Record<string, unknown>;
  const v = bag[key] ?? bag[key.toLowerCase()] ?? bag[key.toUpperCase()];
  if (typeof v === "string") {
    const t = v.trim();
    return /^https?:\/\//i.test(t) ? t : null;
  }
  if (v && typeof v === "object" && "val" in v) {
    const raw = (v as { val?: unknown }).val;
    if (typeof raw === "string") {
      const t = raw.trim();
      return /^https?:\/\//i.test(t) ? t : null;
    }
  }
  return null;
}

function meetingFromEvent(
  ev: VEvent,
): { url: string; provider: ParsedInviteMeetingProvider } | null {
  if (typeof ev.url === "string") {
    const t = ev.url.trim();
    if (/^https?:\/\//i.test(t)) return { url: t, provider: detectProvider(t) };
  }

  const xKeys = [
    "X-GOOGLE-CONFERENCE",
    "X-MICROSOFT-SKYPETEAMSMEETINGURL",
    "X-MS-OLK-CONFTYPE",
    "X-WEBEX-MEETINGURL",
    "X-WEBEX-MEETING-URL",
    "X-ZOOM-MEETING-URL",
  ];
  for (const k of xKeys) {
    const u = readXPropertyUrl(ev, k);
    if (u) return { url: u, provider: detectProvider(u) };
  }

  const loc = typeof ev.location === "string" ? ev.location : "";
  const fromLoc = loc.match(ANY_PROVIDER_URL_RX) ?? loc.match(/https?:\/\/[^\s<>"']+/i);
  if (fromLoc) return { url: fromLoc[0], provider: detectProvider(fromLoc[0]) };

  const desc = typeof ev.description === "string" ? ev.description : "";
  const fromDesc = desc.match(ANY_PROVIDER_URL_RX);
  if (fromDesc) return { url: fromDesc[0], provider: detectProvider(fromDesc[0]) };

  return null;
}

function rruleString(ev: VEvent): string | null {
  const rr = ev.rrule;
  if (!rr) return null;
  try {
    if (typeof (rr as { toString?: () => string }).toString === "function") {
      return (rr as { toString: () => string }).toString();
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Parse RFC 5545 ICS bytes/string. Returns one entry per usable VEVENT
 * (skips malformed components).
 */
export function parseIcs(input: string | Buffer): ParsedInvite[] {
  const str = typeof input === "string" ? input : input.toString("utf8");
  const data = ical.parseICS(str);
  const calMethod = calendarMethod(data);
  const invites: ParsedInvite[] = [];

  for (const key of Object.keys(data)) {
    const c = data[key];
    if (!c || typeof c !== "object" || !("type" in c)) continue;
    if ((c as { type: string }).type !== "VEVENT") continue;
    const ev = c as VEvent;
    if (!ev.uid || !ev.start || !ev.end) continue;

    const org = organizerFromProp(ev.organizer);
    const method =
      typeof ev.method === "string" && ev.method.length > 0 ? ev.method : calMethod ?? null;
    const status = ev.status;
    const isCancellation = status === "CANCELLED" || method === "CANCEL";

    const datetype = ev.datetype;
    const allDay = datetype === "date";

    const meeting = meetingFromEvent(ev);

    invites.push({
      uid: ev.uid,
      sequence: parseSequence(ev.sequence),
      method,
      summary: typeof ev.summary === "string" && ev.summary.length > 0 ? ev.summary : "(no title)",
      ...(typeof ev.description === "string" && ev.description.length > 0
        ? { description: ev.description }
        : {}),
      ...(typeof ev.location === "string" && ev.location.length > 0 ? { location: ev.location } : {}),
      organizerEmail: org.email,
      ...(org.name ? { organizerName: org.name } : {}),
      attendees: collectAttendees(ev),
      start: ev.start,
      end: ev.end,
      allDay,
      isCancellation,
      rrule: rruleString(ev),
      meetingUrl: meeting?.url ?? null,
      meetingProvider: meeting?.provider ?? null,
    });
  }

  return invites;
}

/** Prefer the primary invite VEVENT when multiple components exist. */
export function pickPrimaryInvite(invites: ParsedInvite[]): ParsedInvite | null {
  if (invites.length === 0) return null;
  const req = invites.find((i) => i.method === "REQUEST" || i.method === "PUBLISH");
  if (req) return req;
  return invites[0] ?? null;
}
