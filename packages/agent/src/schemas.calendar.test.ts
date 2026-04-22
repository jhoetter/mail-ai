// Coverage for the calendar additions to the command payload union:
// recurrence + timeZone on create, attendee deltas + recurrence-clear
// + edit-scope on update, edit-scope on delete. The schemas drive
// validation in the CLI, MCP layer, and the agent SDK so a slip here
// silently changes the contract for every entry point.

import { describe, expect, it } from "vitest";
import { CommandPayloadSchema, RecurrenceSchema } from "./schemas.js";

describe("RecurrenceSchema", () => {
  it("parses a weekly RRULE shape", () => {
    const r = RecurrenceSchema.parse({
      freq: "WEEKLY",
      interval: 1,
      byday: ["MO", "WE"],
    });
    expect(r.freq).toBe("WEEKLY");
    expect(r.byday).toEqual(["MO", "WE"]);
  });
  it("rejects unknown freq", () => {
    expect(() => RecurrenceSchema.parse({ freq: "FORTNIGHTLY" })).toThrow();
  });
  it("rejects unknown weekday tokens", () => {
    expect(() =>
      RecurrenceSchema.parse({ freq: "WEEKLY", byday: ["XX"] }),
    ).toThrow();
  });
});

describe("calendar:create-event payload", () => {
  it("accepts the new timeZone + recurrence fields", () => {
    const cmd = CommandPayloadSchema.parse({
      type: "calendar:create-event",
      payload: {
        calendarId: "cal_1",
        summary: "Standup",
        startsAt: "2026-04-22T09:00:00.000Z",
        endsAt: "2026-04-22T09:30:00.000Z",
        timeZone: "Europe/Berlin",
        recurrence: { freq: "DAILY", interval: 1, count: 10 },
      },
    });
    expect(cmd.type).toBe("calendar:create-event");
    if (cmd.type !== "calendar:create-event") return;
    expect(cmd.payload.timeZone).toBe("Europe/Berlin");
    expect(cmd.payload.recurrence?.freq).toBe("DAILY");
  });
});

describe("calendar:update-event payload", () => {
  it("accepts attendee deltas + scope + null recurrence", () => {
    const cmd = CommandPayloadSchema.parse({
      type: "calendar:update-event",
      payload: {
        eventId: "ev_1",
        summary: "Renamed",
        attendeesAdd: ["a@example.com"],
        attendeesRemove: ["b@example.com"],
        recurrence: null,
        scope: "following",
      },
    });
    if (cmd.type !== "calendar:update-event") throw new Error("wrong type");
    expect(cmd.payload.attendeesAdd).toEqual(["a@example.com"]);
    expect(cmd.payload.recurrence).toBeNull();
    expect(cmd.payload.scope).toBe("following");
  });
  it("rejects an invalid scope", () => {
    expect(() =>
      CommandPayloadSchema.parse({
        type: "calendar:update-event",
        payload: { eventId: "ev_1", scope: "everywhere" },
      }),
    ).toThrow();
  });
});

describe("calendar:delete-event payload", () => {
  it("accepts an optional series scope", () => {
    const cmd = CommandPayloadSchema.parse({
      type: "calendar:delete-event",
      payload: { eventId: "ev_1", scope: "series" },
    });
    if (cmd.type !== "calendar:delete-event") throw new Error("wrong type");
    expect(cmd.payload.scope).toBe("series");
  });
  it("accepts no scope at all (single is the implicit default)", () => {
    const cmd = CommandPayloadSchema.parse({
      type: "calendar:delete-event",
      payload: { eventId: "ev_1" },
    });
    if (cmd.type !== "calendar:delete-event") throw new Error("wrong type");
    expect(cmd.payload.scope).toBeUndefined();
  });
});
