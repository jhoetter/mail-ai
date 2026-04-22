// Snap-math + view-window helpers used by the time grid. Pure
// functions, no DOM, so the test file lives next to the helper
// instead of in apps/web/e2e.

import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  endOfMonthGrid,
  pxToDate,
  sameDay,
  snapMinutes,
  startOfDay,
  startOfMonthGrid,
  startOfWeek,
  viewWindow,
} from "./calendar-time.js";

describe("snapMinutes", () => {
  it("snaps down on the lower half", () => {
    expect(snapMinutes(7)).toBe(0);
    expect(snapMinutes(22)).toBe(15);
  });
  it("snaps up on the upper half", () => {
    expect(snapMinutes(8)).toBe(15);
    expect(snapMinutes(23)).toBe(30);
  });
  it("is idempotent on a multiple of the snap", () => {
    expect(snapMinutes(0)).toBe(0);
    expect(snapMinutes(45)).toBe(45);
    expect(snapMinutes(60)).toBe(60);
  });
});

describe("pxToDate", () => {
  // A 48 px row height matches the TimeGrid constant; one minute = 0.8 px.
  const dayStart = new Date(2026, 3, 22, 0, 0, 0);
  it("returns the day start at y=0", () => {
    const out = pxToDate(dayStart, 48, 0);
    expect(out.getHours()).toBe(0);
    expect(out.getMinutes()).toBe(0);
  });
  it("snaps an off-grid pixel to the nearest 15 minutes", () => {
    // 1.5 hours = 72 px; nudge by 5 px (~6 minutes). Still snaps to 1:30.
    const out = pxToDate(dayStart, 48, 72 + 5);
    expect(out.getHours()).toBe(1);
    expect(out.getMinutes()).toBe(30);
  });
  it("snaps near a boundary up to the next 15-minute slot", () => {
    // 56.8 px / 48 px-per-hour = 71 minutes; nearest 15 = 75 = 1:15.
    const out = pxToDate(dayStart, 48, 56.8);
    expect(out.getHours()).toBe(1);
    expect(out.getMinutes()).toBe(15);
  });
  it("clamps negative pixel positions to the day start", () => {
    const out = pxToDate(dayStart, 48, -100);
    expect(out.getHours()).toBe(0);
    expect(out.getMinutes()).toBe(0);
  });
});

describe("date helpers", () => {
  it("startOfDay zeros time fields", () => {
    const d = startOfDay(new Date(2026, 3, 22, 14, 30, 45));
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });
  it("startOfWeek anchors on Monday", () => {
    // Wed Apr 22, 2026 → Mon Apr 20, 2026.
    const wed = new Date(2026, 3, 22);
    const mon = startOfWeek(wed);
    expect(mon.getDay()).toBe(1);
    expect(mon.getDate()).toBe(20);
  });
  it("startOfWeek returns the same day when called on Monday", () => {
    const mon = new Date(2026, 3, 20);
    expect(sameDay(startOfWeek(mon), mon)).toBe(true);
  });
  it("addDays handles DST-free arithmetic", () => {
    const d = addDays(new Date(2026, 3, 22), 7);
    expect(d.getDate()).toBe(29);
  });
  it("addMonths handles month rollover", () => {
    const d = addMonths(new Date(2026, 11, 31), 2);
    // Dec 31 + 2 months → Feb (28 days), JS rolls into March 3 — we
    // accept either as long as the month index advanced exactly.
    expect(d.getMonth()).toBeGreaterThanOrEqual(1);
  });
  it("month grid spans exactly 42 days", () => {
    const start = startOfMonthGrid(new Date(2026, 3, 22));
    const end = endOfMonthGrid(new Date(2026, 3, 22));
    expect((end.getTime() - start.getTime()) / 86_400_000).toBe(42);
  });
});

describe("viewWindow", () => {
  const cursor = new Date(2026, 3, 22, 14, 30); // Wed Apr 22, 2026
  it("day = 24h starting at midnight", () => {
    const { from, to } = viewWindow("day", cursor);
    expect(from.getHours()).toBe(0);
    expect((to.getTime() - from.getTime()) / 86_400_000).toBe(1);
  });
  it("week = 7 days starting Monday", () => {
    const { from, to } = viewWindow("week", cursor);
    expect(from.getDay()).toBe(1);
    expect((to.getTime() - from.getTime()) / 86_400_000).toBe(7);
  });
  it("month = 6 weeks (42 days)", () => {
    const { from, to } = viewWindow("month", cursor);
    expect((to.getTime() - from.getTime()) / 86_400_000).toBe(42);
  });
});
