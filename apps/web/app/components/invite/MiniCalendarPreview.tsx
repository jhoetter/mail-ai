"use client";

import { useMemo } from "react";

export interface ConflictBlock {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly summary: string | null;
}

interface Props {
  readonly inviteStart: string;
  readonly inviteEnd: string;
  readonly allDay: boolean;
  readonly conflicts: readonly ConflictBlock[];
}

function startOfLocalDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Three-day strip around the invite with a highlighted slot + conflict stripes. */
export function MiniCalendarPreview({ inviteStart, inviteEnd, allDay, conflicts }: Props) {
  const center = useMemo(() => new Date(inviteStart), [inviteStart]);
  const days = useMemo(() => {
    const s = startOfLocalDay(center);
    return [addDays(s, -1), s, addDays(s, 1)];
  }, [center]);

  const invStart = new Date(inviteStart);
  const invEnd = new Date(inviteEnd);

  const dayLabel = (d: Date) =>
    d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

  return (
    <div className="mt-3 rounded-lg border border-divider bg-surface/50 p-3">
      <div className="grid grid-cols-3 gap-2 text-center">
        {days.map((d) => {
          const isMid = d.getTime() === days[1]!.getTime();
          return (
            <div
              key={d.toISOString()}
              className={
                "rounded-md border px-1 py-2 text-[11px] " +
                (isMid ? "border-accent/40 bg-background" : "border-divider bg-background/80")
              }
            >
              <div className="font-medium text-secondary">{dayLabel(d)}</div>
              {isMid ? (
                <div className="mt-2 space-y-1">
                  {conflicts.map((c) => {
                    const cs = new Date(c.startsAt);
                    const ce = new Date(c.endsAt);
                    if (ce <= d || cs >= addDays(d, 1)) return null;
                    return (
                      <div
                        key={`${c.startsAt}-${c.summary}`}
                        title={c.summary ?? ""}
                        className="truncate rounded bg-[var(--bit-orange)]/15 px-1 py-0.5 text-[10px] text-foreground ring-1 ring-[var(--bit-orange)]/40"
                      >
                        {c.summary ?? "Busy"}
                      </div>
                    );
                  })}
                  <div
                    className={
                      "rounded px-1 py-1 text-[10px] font-medium text-foreground " +
                      (allDay ? "bg-hover" : "bg-[var(--accent)]/15 ring-1 ring-[var(--accent)]/30")
                    }
                  >
                    {allDay
                      ? "All day"
                      : `${invStart.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} – ${invEnd.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
                  </div>
                </div>
              ) : (
                <div className="mt-2 text-[10px] text-tertiary">—</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
