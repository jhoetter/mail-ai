// Greedy column packing for overlapping time-grid events. The grid
// renders each tile at width = 1/columns, so the math here directly
// drives whether two simultaneous meetings render side-by-side or
// stacked on top of each other.

import { describe, expect, it } from "vitest";
import { layoutDayEvents } from "./event-layout.js";
import type { CalendarEvent } from "./useCalendarState.js";

function ev(id: string, startH: number, endH: number): CalendarEvent {
  const start = new Date(2026, 3, 22, startH, 0, 0);
  const end = new Date(2026, 3, 22, endH, 0, 0);
  return {
    id,
    providerEventId: id,
    icalUid: null,
    summary: id,
    description: null,
    location: null,
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    allDay: false,
    attendees: [],
    organizerEmail: null,
    responseStatus: null,
    status: null,
    calendarId: "cal_1",
  };
}

describe("layoutDayEvents", () => {
  const dayStart = new Date(2026, 3, 22, 0, 0, 0);
  const dayEnd = new Date(2026, 3, 23, 0, 0, 0);

  it("non-overlapping events take 1 column each", () => {
    const out = layoutDayEvents(
      [ev("a", 9, 10), ev("b", 11, 12)],
      dayStart,
      dayEnd,
    );
    expect(out).toHaveLength(2);
    expect(out.every((it) => it.columns === 1 && it.column === 0)).toBe(true);
  });

  it("two overlapping events split the column count to 2", () => {
    const out = layoutDayEvents(
      [ev("a", 9, 11), ev("b", 10, 12)],
      dayStart,
      dayEnd,
    );
    expect(out).toHaveLength(2);
    expect(out.map((it) => it.columns)).toEqual([2, 2]);
    expect(new Set(out.map((it) => it.column))).toEqual(new Set([0, 1]));
  });

  it("three concurrent events all share columns=3", () => {
    const out = layoutDayEvents(
      [ev("a", 9, 12), ev("b", 9, 12), ev("c", 9, 12)],
      dayStart,
      dayEnd,
    );
    expect(out.map((it) => it.columns)).toEqual([3, 3, 3]);
  });

  it("events with a gap form independent clusters", () => {
    const out = layoutDayEvents(
      [ev("a", 9, 10), ev("b", 9, 10), ev("c", 11, 12)],
      dayStart,
      dayEnd,
    );
    const c = out.find((x) => x.event.id === "c")!;
    expect(c.columns).toBe(1);
    const a = out.find((x) => x.event.id === "a")!;
    const b = out.find((x) => x.event.id === "b")!;
    expect(a.columns).toBe(2);
    expect(b.columns).toBe(2);
  });

  it("drops events fully outside the day window", () => {
    const out = layoutDayEvents(
      [ev("a", 9, 10), { ...ev("late", 25, 26) }],
      dayStart,
      dayEnd,
    );
    expect(out).toHaveLength(1);
  });
});
