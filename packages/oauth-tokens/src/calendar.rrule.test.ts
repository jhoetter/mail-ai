// RFC 5545 RRULE serialization round-trips. The Google adapter passes
// these strings straight to the upstream API, so a regression here
// breaks every recurring create / update.

import { describe, expect, it } from "vitest";
import { parseRRule, serializeRRule } from "./calendar.js";

describe("serializeRRule", () => {
  it("emits a minimal FREQ-only rule", () => {
    expect(serializeRRule({ freq: "DAILY" })).toBe("FREQ=DAILY");
  });
  it("omits INTERVAL when it is 1", () => {
    expect(serializeRRule({ freq: "WEEKLY", interval: 1 })).toBe("FREQ=WEEKLY");
  });
  it("includes INTERVAL when greater than 1", () => {
    expect(serializeRRule({ freq: "WEEKLY", interval: 2 })).toBe(
      "FREQ=WEEKLY;INTERVAL=2",
    );
  });
  it("includes COUNT", () => {
    expect(serializeRRule({ freq: "DAILY", count: 5 })).toBe(
      "FREQ=DAILY;COUNT=5",
    );
  });
  it("formats UNTIL as RFC 5545 UTC basic ISO", () => {
    const until = new Date(Date.UTC(2026, 5, 1, 9, 30, 0));
    expect(serializeRRule({ freq: "DAILY", until })).toBe(
      "FREQ=DAILY;UNTIL=20260601T093000Z",
    );
  });
  it("emits BYDAY in input order", () => {
    expect(
      serializeRRule({ freq: "WEEKLY", byday: ["MO", "WE", "FR"] }),
    ).toBe("FREQ=WEEKLY;BYDAY=MO,WE,FR");
  });
  it("emits BYMONTHDAY", () => {
    expect(serializeRRule({ freq: "MONTHLY", bymonthday: [1, 15] })).toBe(
      "FREQ=MONTHLY;BYMONTHDAY=1,15",
    );
  });
});

describe("parseRRule", () => {
  it("ignores the optional RRULE: prefix", () => {
    const r = parseRRule("RRULE:FREQ=DAILY;INTERVAL=2");
    expect(r?.freq).toBe("DAILY");
    expect(r?.interval).toBe(2);
  });
  it("parses BYDAY into an array", () => {
    const r = parseRRule("FREQ=WEEKLY;BYDAY=MO,WE");
    expect(r?.byday).toEqual(["MO", "WE"]);
  });
  it("returns null on an unsupported FREQ", () => {
    expect(parseRRule("FREQ=SECONDLY")).toBeNull();
  });
});

describe("RRULE round-trip", () => {
  // The serialize → parse → serialize pass should be a fixed-point
  // for every shape we generate ourselves; otherwise our updates to
  // a series would silently drift from what we read back.
  it("survives a weekly+byday+count round-trip", () => {
    const rule = {
      freq: "WEEKLY" as const,
      interval: 2,
      count: 6,
      byday: ["TU", "TH"] as const,
    };
    const serialized = serializeRRule(rule);
    const parsed = parseRRule(serialized);
    expect(parsed).not.toBeNull();
    expect(serializeRRule(parsed!)).toBe(serialized);
  });
});
