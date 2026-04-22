// Compute side-by-side columns for overlapping time-grid events.
// Classic interval-graph greedy: events sorted by start, each gets
// the lowest free column. We additionally compute cluster width so
// the rendered tile is `1/clusterColumns` wide regardless of where
// in the cluster the event lives.

import type { CalendarEvent } from "./useCalendarState";

export interface LaidOutEvent {
  readonly event: CalendarEvent;
  readonly startMs: number;
  readonly endMs: number;
  readonly column: number;
  readonly columns: number;
}

interface Slot {
  readonly event: CalendarEvent;
  readonly startMs: number;
  readonly endMs: number;
  readonly column: number;
}

export function layoutDayEvents(
  events: ReadonlyArray<CalendarEvent>,
  dayStart: Date,
  dayEnd: Date,
): ReadonlyArray<LaidOutEvent> {
  const dayStartMs = dayStart.getTime();
  const dayEndMs = dayEnd.getTime();
  const items = events
    .map((e) => {
      const startMs = Math.max(dayStartMs, new Date(e.startsAt).getTime());
      const endMs = Math.min(dayEndMs, new Date(e.endsAt).getTime());
      return { event: e, startMs, endMs };
    })
    .filter((i) => i.endMs > i.startMs && i.startMs < dayEndMs && i.endMs > dayStartMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const out: LaidOutEvent[] = [];
  let cluster: Slot[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (cluster.length === 0) return;
    const cols = cluster.reduce((m, s) => Math.max(m, s.column + 1), 1);
    for (const s of cluster) {
      out.push({
        event: s.event,
        startMs: s.startMs,
        endMs: s.endMs,
        column: s.column,
        columns: cols,
      });
    }
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const it of items) {
    if (it.startMs >= clusterEnd) flush();
    const taken = new Set(
      cluster.filter((s) => s.endMs > it.startMs).map((s) => s.column),
    );
    let col = 0;
    while (taken.has(col)) col += 1;
    cluster.push({ event: it.event, startMs: it.startMs, endMs: it.endMs, column: col });
    clusterEnd = Math.max(clusterEnd, it.endMs);
  }
  flush();
  return out;
}
