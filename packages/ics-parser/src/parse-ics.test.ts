import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseIcs, pickPrimaryInvite } from "./parse-ics.js";

const here = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): string {
  return readFileSync(join(here, "..", "__fixtures__", name), "utf8");
}

describe("parseIcs", () => {
  it("parses METHOD:REQUEST invite", () => {
    const invites = parseIcs(fixture("request-basic.ics"));
    const p = pickPrimaryInvite(invites);
    expect(p).not.toBeNull();
    expect(p!.uid).toBe("fixture-req-001@mail-ai");
    expect(p!.method).toBe("REQUEST");
    expect(p!.summary).toBe("test");
    expect(p!.organizerEmail).toBe("alice@example.com");
    expect(p!.organizerName).toBe("Alice");
    expect(p!.attendees).toHaveLength(1);
    expect(p!.attendees[0]?.email).toBe("bob@example.com");
    expect(p!.isCancellation).toBe(false);
    expect(p!.allDay).toBe(false);
  });

  it("parses CANCEL", () => {
    const invites = parseIcs(fixture("cancel-basic.ics"));
    const p = pickPrimaryInvite(invites);
    expect(p).not.toBeNull();
    expect(p!.isCancellation).toBe(true);
    expect(p!.method).toBe("CANCEL");
  });

  it("detects all-day events", () => {
    const invites = parseIcs(fixture("all-day.ics"));
    const p = pickPrimaryInvite(invites);
    expect(p).not.toBeNull();
    expect(p!.allDay).toBe(true);
  });

  it("extracts Google Meet URL from X-GOOGLE-CONFERENCE", () => {
    const invites = parseIcs(fixture("google-meet.ics"));
    const p = pickPrimaryInvite(invites);
    expect(p).not.toBeNull();
    expect(p!.meetingUrl).toBe("https://meet.google.com/abc-defg-hij");
    expect(p!.meetingProvider).toBe("google-meet");
  });

  it("extracts Teams URL from X-MICROSOFT-SKYPETEAMSMEETINGURL", () => {
    const invites = parseIcs(fixture("teams.ics"));
    const p = pickPrimaryInvite(invites);
    expect(p).not.toBeNull();
    expect(p!.meetingUrl).toMatch(/^https:\/\/teams\.microsoft\.com\//);
    expect(p!.meetingProvider).toBe("ms-teams");
  });

  it("extracts Zoom URL from DESCRIPTION when LOCATION is empty", () => {
    const invites = parseIcs(fixture("zoom.ics"));
    const p = pickPrimaryInvite(invites);
    expect(p).not.toBeNull();
    expect(p!.meetingUrl).toMatch(/^https:\/\/us02web\.zoom\.us\/j\//);
    expect(p!.meetingProvider).toBe("zoom");
  });

  it("returns null meetingUrl/Provider when no conference link is present", () => {
    const invites = parseIcs(fixture("request-basic.ics"));
    const p = pickPrimaryInvite(invites);
    expect(p).not.toBeNull();
    expect(p!.meetingUrl).toBeNull();
    expect(p!.meetingProvider).toBeNull();
  });
});
