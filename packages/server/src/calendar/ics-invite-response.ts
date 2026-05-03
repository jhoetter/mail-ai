import {
  parseIcs,
  pickPrimaryInvite,
  type ParsedInvite,
  type ParsedInviteAttendee,
  type ParsedInviteMeetingProvider,
} from "@mailai/ics-parser";
import { CalendarRepository, withTenant, type Pool } from "@mailai/overlay-db";

export interface InviteJson {
  readonly uid: string;
  readonly sequence: number;
  readonly method: string | null;
  readonly summary: string;
  readonly description?: string;
  readonly location?: string;
  readonly organizerEmail: string | null;
  readonly organizerName?: string;
  readonly attendees: readonly ParsedInviteAttendee[];
  readonly start: string;
  readonly end: string;
  readonly allDay: boolean;
  readonly isCancellation: boolean;
  readonly rrule?: string | null;
  readonly meetingUrl?: string | null;
  readonly meetingProvider?: ParsedInviteMeetingProvider | null;
}

export function inviteToJson(inv: ParsedInvite): InviteJson {
  return {
    uid: inv.uid,
    sequence: inv.sequence,
    method: inv.method,
    summary: inv.summary,
    ...(inv.description !== undefined ? { description: inv.description } : {}),
    ...(inv.location !== undefined ? { location: inv.location } : {}),
    organizerEmail: inv.organizerEmail,
    ...(inv.organizerName !== undefined ? { organizerName: inv.organizerName } : {}),
    attendees: inv.attendees,
    start: inv.start.toISOString(),
    end: inv.end.toISOString(),
    allDay: inv.allDay,
    isCancellation: inv.isCancellation,
    ...(inv.rrule !== undefined ? { rrule: inv.rrule } : {}),
    ...(inv.meetingUrl !== undefined ? { meetingUrl: inv.meetingUrl } : {}),
    ...(inv.meetingProvider !== undefined ? { meetingProvider: inv.meetingProvider } : {}),
  };
}

function eventToLite(ev: {
  id: string;
  summary: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  icalUid: string | null;
  calendarId: string;
}) {
  return {
    id: ev.id,
    summary: ev.summary,
    startsAt: ev.startsAt.toISOString(),
    endsAt: ev.endsAt.toISOString(),
    allDay: ev.allDay,
    icalUid: ev.icalUid,
    calendarId: ev.calendarId,
  };
}

export type IcsInviteApiBody = {
  invite: ReturnType<typeof inviteToJson>;
  conflicts: ReturnType<typeof eventToLite>[];
  existing: ReturnType<typeof eventToLite> | null;
};

export async function resolveIcsBufferForTenant(
  pool: Pool,
  tenantId: string,
  buf: Buffer,
): Promise<{ ok: true; body: IcsInviteApiBody } | { ok: false; error: "parse_failed" }> {
  const invites = parseIcs(buf);
  const invite = pickPrimaryInvite(invites);
  if (!invite) return { ok: false, error: "parse_failed" };
  const existingAndConflicts = await withTenant(pool, tenantId, async (tx) => {
    const cal = new CalendarRepository(tx);
    const [conflicts, existing] = await Promise.all([
      cal.listOverlappingVisibleEvents(tenantId, invite.start, invite.end, invite.uid),
      cal.byIcalUid(tenantId, invite.uid),
    ]);
    return { conflicts, existing };
  });
  return {
    ok: true,
    body: {
      invite: inviteToJson(invite),
      conflicts: existingAndConflicts.conflicts.map(eventToLite),
      existing: existingAndConflicts.existing ? eventToLite(existingAndConflicts.existing) : null,
    },
  };
}
