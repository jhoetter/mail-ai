"use client";

// Provider-agnostic calendar invite card.
//
// Whenever an inbound message has a parseable iTIP/ICS payload (whether
// shipped as an .ics attachment or carried inline as text/calendar in the
// body), this card replaces the body. Everything we render here comes
// from the open standard (RFC 5545 / iTIP) — never from provider HTML.
// That means the same card renders cleanly for Google Meet, Microsoft
// Teams, Zoom, Webex, GoToMeeting, or anything else that ships an ICS
// invite.
//
// RSVP flows through `calendar:respond-from-ics`, which dispatches the
// REPLY iCalendar back through the original mail provider's transport
// (Gmail / Graph). No provider deep-link or iframe is required.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Calendar as CalendarIcon,
  Check,
  Clock,
  ExternalLink,
  HelpCircle,
  MapPin,
  Repeat,
  Users,
  Video,
  X,
} from "lucide-react";
import { Button } from "@mailai/ui";
import { apiFetch } from "../../lib/api";
import { useTranslator } from "../../lib/i18n/useTranslator";
import type { ThreadAttachment, ThreadMessage } from "../../lib/threads-client";
import { respondInviteFromIcs } from "../../lib/calendar-client";
import { MiniCalendarPreview, type ConflictBlock } from "./MiniCalendarPreview";

type MeetingProvider =
  | "google-meet"
  | "ms-teams"
  | "zoom"
  | "webex"
  | "gotomeeting"
  | "other";

interface IcsApiInviteAttendee {
  email: string;
  name?: string;
  partstat?: string;
  rsvp?: boolean;
  organizer?: boolean;
}

interface IcsApiInvite {
  uid: string;
  sequence: number;
  method: string | null;
  summary: string;
  description?: string;
  location?: string;
  organizerEmail: string | null;
  organizerName?: string;
  attendees: IcsApiInviteAttendee[];
  start: string;
  end: string;
  allDay: boolean;
  isCancellation: boolean;
  meetingUrl?: string | null;
  meetingProvider?: MeetingProvider | null;
  rrule?: string | null;
}

interface IcsApiResponse {
  invite: IcsApiInvite;
  conflicts: ConflictBlock[];
  existing: { id: string; summary: string | null } | null;
}

function pickInviteAttachment(attachments: readonly ThreadAttachment[]): ThreadAttachment | null {
  for (const a of attachments) {
    const mt = (a.mime ?? "").toLowerCase();
    const fn = (a.filename ?? "").toLowerCase();
    if (mt.includes("calendar") || mt.includes("ics") || fn.endsWith(".ics")) return a;
  }
  return null;
}

type IcsSource =
  | { kind: "attachment"; id: string }
  | { kind: "messageBody"; messageId: string };

function resolveIcsSource(message: ThreadMessage): IcsSource | null {
  const att = pickInviteAttachment(message.attachments);
  if (att) return { kind: "attachment", id: att.id };
  if (message.bodyIcs?.trim()) return { kind: "messageBody", messageId: message.id };
  return null;
}

function providerLabelKey(p: MeetingProvider | null | undefined): string {
  switch (p) {
    case "google-meet":
      return "thread.inviteJoinGoogleMeet";
    case "ms-teams":
      return "thread.inviteJoinTeams";
    case "zoom":
      return "thread.inviteJoinZoom";
    case "webex":
      return "thread.inviteJoinWebex";
    case "gotomeeting":
      return "thread.inviteJoinGoToMeeting";
    default:
      return "thread.inviteJoin";
  }
}

function partstatToTone(
  partstat: string | undefined,
): "accepted" | "declined" | "tentative" | "pending" {
  switch ((partstat ?? "").toLowerCase()) {
    case "accepted":
      return "accepted";
    case "declined":
      return "declined";
    case "tentative":
      return "tentative";
    default:
      return "pending";
  }
}

interface Props {
  readonly message: ThreadMessage;
  readonly onChanged: () => void;
}

export function InviteCard({ message, onChanged }: Props) {
  const { t, locale } = useTranslator();
  const source = useMemo(() => resolveIcsSource(message), [message]);
  const att = useMemo(() => pickInviteAttachment(message.attachments), [message.attachments]);
  const [data, setData] = useState<IcsApiResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [myResponse, setMyResponse] = useState<"accepted" | "declined" | "tentative" | null>(null);

  const sourceKey = useMemo(
    () =>
      source
        ? source.kind === "attachment"
          ? `a:${source.id}`
          : `m:${source.messageId}`
        : "",
    [source],
  );

  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    setErr(null);
    const url =
      source.kind === "attachment"
        ? `/api/attachments/${encodeURIComponent(source.id)}/ics`
        : `/api/messages/${encodeURIComponent(source.messageId)}/ics`;
    void apiFetch(url)
      .then(async (r) => {
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { message?: string };
          throw new Error(j.message ?? r.statusText);
        }
        return (await r.json()) as IcsApiResponse;
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [source, sourceKey]);

  const onRsvp = useCallback(
    async (response: "accepted" | "declined" | "tentative") => {
      if (!source) return;
      setBusy(response);
      try {
        await respondInviteFromIcs({
          messageId: message.id,
          ...(att ? { attachmentId: att.id } : {}),
          response,
        });
        setMyResponse(response);
        onChanged();
      } catch (e) {
        window.alert(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [att, message.id, onChanged, source],
  );

  if (!source) return null;
  if (err) {
    return (
      <div className="mb-3 rounded-lg border border-divider bg-hover px-3 py-2 text-xs text-secondary">
        {t("thread.inviteLoadError")}: {err}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="mb-3 rounded-lg border border-divider bg-surface px-3 py-2 text-xs text-secondary">
        {t("thread.inviteLoading")}
      </div>
    );
  }

  const inv = data.invite;
  if (inv.isCancellation) {
    return (
      <div className="mb-3 flex items-start gap-2 rounded-lg border border-divider bg-hover px-3 py-2 text-sm text-secondary">
        <X size={14} aria-hidden className="mt-0.5 shrink-0" />
        <span>{t("thread.inviteCancelled", { title: inv.summary })}</span>
      </div>
    );
  }

  const fmt = formatInviteWhen({
    locale,
    startIso: inv.start,
    endIso: inv.end,
    allDay: inv.allDay,
  });
  const organizerLabel =
    inv.organizerName || inv.organizerEmail || t("thread.inviteUnknownOrganizer");
  const providerKey = providerLabelKey(inv.meetingProvider);
  const showLocation = inv.location && inv.location.trim().length > 0 && !inv.meetingUrl;

  return (
    <div className="mb-4 overflow-hidden rounded-lg border border-divider bg-surface">
      <div className="flex items-start gap-3 border-b border-divider px-3 py-3 sm:px-4">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-background text-foreground"
          aria-hidden
        >
          <CalendarIcon size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-foreground">{inv.summary}</h3>
          <p className="mt-0.5 truncate text-xs text-secondary">
            {t("thread.inviteOrganizer")}: {organizerLabel}
          </p>
        </div>
        {data.existing ? (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-md bg-background px-1.5 py-0.5 text-[11px] font-medium text-secondary"
            title={t("thread.inviteOnCalendar")}
          >
            <Check size={11} aria-hidden />
            {t("thread.inviteOnCalendar")}
          </span>
        ) : null}
      </div>

      <div className="space-y-2 px-3 py-3 sm:px-4">
        <InviteRow icon={<Clock size={14} />}>
          <span className="text-foreground">{fmt.line1}</span>
          {fmt.line2 ? <span className="ml-1.5 text-secondary">· {fmt.line2}</span> : null}
        </InviteRow>

        {inv.rrule ? (
          <InviteRow icon={<Repeat size={14} />}>
            <span className="text-secondary">{humanizeRrule(inv.rrule, t)}</span>
          </InviteRow>
        ) : null}

        {inv.meetingUrl ? (
          <InviteRow icon={<Video size={14} />}>
            <a
              href={inv.meetingUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline"
            >
              {t(providerKey)}
              <ExternalLink size={11} aria-hidden />
            </a>
          </InviteRow>
        ) : null}

        {showLocation ? (
          <InviteRow icon={<MapPin size={14} />}>
            <span className="break-words text-secondary">{inv.location}</span>
          </InviteRow>
        ) : null}

        {inv.attendees.length > 0 ? (
          <InviteRow icon={<Users size={14} />}>
            <AttendeeChips attendees={inv.attendees} />
          </InviteRow>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t border-divider bg-background px-3 py-2.5 sm:px-4">
        <span className="mr-1 text-xs text-secondary">{t("thread.inviteRsvpPrompt")}</span>
        <Button
          size="sm"
          variant={myResponse === "accepted" ? "primary" : "secondary"}
          disabled={busy !== null}
          onClick={() => void onRsvp("accepted")}
        >
          {busy === "accepted" ? "…" : t("thread.inviteAccept")}
        </Button>
        <Button
          size="sm"
          variant={myResponse === "tentative" ? "primary" : "secondary"}
          disabled={busy !== null}
          onClick={() => void onRsvp("tentative")}
        >
          {busy === "tentative" ? "…" : t("thread.inviteMaybe")}
        </Button>
        <Button
          size="sm"
          variant={myResponse === "declined" ? "primary" : "secondary"}
          disabled={busy !== null}
          onClick={() => void onRsvp("declined")}
        >
          {busy === "declined" ? "…" : t("thread.inviteDecline")}
        </Button>
        <a
          href={`${typeof window !== "undefined" ? window.location.origin : ""}/calendar`}
          className="ml-auto inline-flex h-8 items-center rounded-md px-2 text-xs font-medium text-secondary hover:bg-hover hover:text-foreground"
        >
          {t("thread.inviteOpenCalendar")}
        </a>
      </div>

      <div className="border-t border-divider px-3 py-2 sm:px-4">
        <MiniCalendarPreview
          inviteStart={inv.start}
          inviteEnd={inv.end}
          allDay={inv.allDay}
          conflicts={data.conflicts}
        />
        {data.conflicts.length > 0 ? (
          <p className="mt-1 text-[11px] text-[var(--bit-orange)]">{t("thread.inviteConflicts")}</p>
        ) : null}
      </div>
    </div>
  );
}

function InviteRow({
  icon,
  children,
}: {
  readonly icon: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="mt-0.5 shrink-0 text-tertiary" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function AttendeeChips({ attendees }: { readonly attendees: IcsApiInviteAttendee[] }) {
  const visible = attendees.slice(0, 6);
  const overflow = attendees.length - visible.length;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {visible.map((a) => (
        <AttendeeChip key={a.email} attendee={a} />
      ))}
      {overflow > 0 ? (
        <span className="rounded-md bg-hover px-1.5 py-0.5 text-[11px] text-secondary">
          +{overflow}
        </span>
      ) : null}
    </div>
  );
}

function AttendeeChip({ attendee }: { readonly attendee: IcsApiInviteAttendee }) {
  const tone = partstatToTone(attendee.partstat);
  const label = attendee.name?.trim() || attendee.email;
  const tip = attendee.email + (attendee.organizer ? " (organizer)" : "");
  const ringClass =
    tone === "accepted"
      ? "ring-1 ring-[var(--success-ring,theme(colors.green.500))]"
      : tone === "declined"
        ? "ring-1 ring-[var(--bit-orange)]"
        : tone === "tentative"
          ? "ring-1 ring-[var(--accent)]"
          : "";
  return (
    <span
      className={`inline-flex max-w-[12rem] items-center gap-1 rounded-md bg-hover px-1.5 py-0.5 text-[11px] text-secondary ${ringClass}`}
      title={tip}
    >
      <span className="truncate">{label}</span>
      <PartstatGlyph tone={tone} />
    </span>
  );
}

function PartstatGlyph({
  tone,
}: {
  readonly tone: "accepted" | "declined" | "tentative" | "pending";
}) {
  switch (tone) {
    case "accepted":
      return <Check size={10} aria-hidden className="shrink-0 text-foreground" />;
    case "declined":
      return <X size={10} aria-hidden className="shrink-0 text-[var(--bit-orange)]" />;
    case "tentative":
      return <HelpCircle size={10} aria-hidden className="shrink-0 text-[var(--accent)]" />;
    case "pending":
      return null;
  }
}

function formatInviteWhen({
  locale,
  startIso,
  endIso,
  allDay,
}: {
  locale: string;
  startIso: string;
  endIso: string;
  allDay: boolean;
}): { line1: string; line2: string | null } {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const sameDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();
  const dateOpts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: start.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  };
  const date1 = new Intl.DateTimeFormat(locale, dateOpts).format(start);
  if (allDay) {
    if (sameDay) return { line1: date1, line2: null };
    const date2 = new Intl.DateTimeFormat(locale, dateOpts).format(end);
    return { line1: `${date1} – ${date2}`, line2: null };
  }
  const timeOpts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
  const t1 = new Intl.DateTimeFormat(locale, timeOpts).format(start);
  const t2 = new Intl.DateTimeFormat(locale, timeOpts).format(end);
  if (sameDay) {
    const tz = inviteTimezoneAbbrev(start, locale);
    return { line1: date1, line2: tz ? `${t1} – ${t2} ${tz}` : `${t1} – ${t2}` };
  }
  const date2 = new Intl.DateTimeFormat(locale, dateOpts).format(end);
  return { line1: `${date1} ${t1}`, line2: `${date2} ${t2}` };
}

function inviteTimezoneAbbrev(date: Date, locale: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat(locale, {
      hour: "numeric",
      timeZoneName: "short",
    }).formatToParts(date);
    const tz = parts.find((p) => p.type === "timeZoneName");
    return tz?.value ?? null;
  } catch {
    return null;
  }
}

function humanizeRrule(rrule: string, t: (k: string) => string): string {
  const r = rrule.toUpperCase();
  if (r.includes("FREQ=DAILY")) return t("thread.inviteRecurDaily");
  if (r.includes("FREQ=WEEKLY")) return t("thread.inviteRecurWeekly");
  if (r.includes("FREQ=MONTHLY")) return t("thread.inviteRecurMonthly");
  if (r.includes("FREQ=YEARLY")) return t("thread.inviteRecurYearly");
  return t("thread.inviteRecurs");
}
