import { describe, expect, it } from "vitest";
import { composeIcs, type IcsEvent } from "./ics.js";

// Reverse RFC 5545 §3.1 line folding so semantic assertions don't have
// to know about which lines crossed the 75-octet boundary.
function unfold(body: string): string {
  return body.replace(/\r\n[ \t]/g, "");
}

const baseEvent: IcsEvent = {
  uid: "evt-uid-123@mail-ai.local",
  sequence: 0,
  dtstamp: new Date("2026-04-22T10:00:00Z"),
  dtstart: new Date("2026-05-01T14:00:00Z"),
  dtend: new Date("2026-05-01T15:00:00Z"),
  summary: "Quarterly review",
  organizer: { email: "alice@example.com", name: "Alice" },
  attendees: [{ email: "bob@example.com", name: "Bob" }, { email: "carol@example.com" }],
};

describe("composeIcs", () => {
  it("emits a well-formed REQUEST", () => {
    const { body, contentType } = composeIcs(baseEvent, "REQUEST");
    const u = unfold(body);
    expect(contentType).toBe("text/calendar; charset=UTF-8; method=REQUEST");
    expect(u).toContain("BEGIN:VCALENDAR");
    expect(u).toContain("METHOD:REQUEST");
    expect(u).toContain("BEGIN:VEVENT");
    expect(u).toContain("END:VEVENT");
    expect(u).toContain("END:VCALENDAR");
    expect(u).toContain("UID:evt-uid-123@mail-ai.local");
    expect(u).toContain("SEQUENCE:0");
    expect(u).toContain("DTSTART:20260501T140000Z");
    expect(u).toContain("DTEND:20260501T150000Z");
    expect(u).toContain("SUMMARY:Quarterly review");
    expect(u).toContain("STATUS:CONFIRMED");
    expect(u).toContain("ORGANIZER;CN=Alice:mailto:alice@example.com");
    expect(u).toContain(
      "ATTENDEE;CN=Bob;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:bob@example.com",
    );
    expect(u).toContain(
      "ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:carol@example.com",
    );
    // CRLF line endings throughout.
    expect(body.endsWith("\r\n")).toBe(true);
    expect(body.split("\r\n").length).toBeGreaterThan(5);
  });

  it("emits CANCEL with bumped sequence and CANCELLED status", () => {
    const { body } = composeIcs({ ...baseEvent, sequence: 2 }, "CANCEL");
    expect(body).toContain("METHOD:CANCEL");
    expect(body).toContain("SEQUENCE:2");
    expect(body).toContain("STATUS:CANCELLED");
  });

  it("emits REPLY with the responder's PARTSTAT", () => {
    const { body } = composeIcs(
      {
        ...baseEvent,
        attendees: [
          {
            email: "bob@example.com",
            name: "Bob",
            partstat: "ACCEPTED",
          },
        ],
      },
      "REPLY",
    );
    const u = unfold(body);
    expect(u).toContain("METHOD:REPLY");
    expect(u).toContain(
      "ATTENDEE;CN=Bob;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:bob@example.com",
    );
    // Only one ATTENDEE line in the output (after unfolding).
    const matches = u.match(/^ATTENDEE/gm);
    expect(matches?.length).toBe(1);
  });

  it("escapes commas, semicolons, backslashes and newlines in TEXT", () => {
    const { body } = composeIcs(
      {
        ...baseEvent,
        summary: "Project: a, b; and c\\d",
        description: "Line 1\nLine 2",
      },
      "REQUEST",
    );
    expect(body).toContain("SUMMARY:Project: a\\, b\\; and c\\\\d");
    expect(body).toContain("DESCRIPTION:Line 1\\nLine 2");
  });

  it("emits VALUE=DATE for all-day events", () => {
    const { body } = composeIcs(
      {
        ...baseEvent,
        allDay: true,
        dtstart: new Date("2026-05-01T00:00:00Z"),
        dtend: new Date("2026-05-02T00:00:00Z"),
      },
      "REQUEST",
    );
    expect(body).toContain("DTSTART;VALUE=DATE:20260501");
    expect(body).toContain("DTEND;VALUE=DATE:20260502");
    expect(body).not.toContain("DTSTART:");
  });

  it("folds long lines at 75 octets with leading space continuation", () => {
    const long = "x".repeat(200);
    const { body } = composeIcs({ ...baseEvent, summary: long }, "REQUEST");
    const summaryLines = body
      .split("\r\n")
      .filter(
        (l, i, all) =>
          l.startsWith("SUMMARY:") ||
          (i > 0 && all[i - 1]!.startsWith("SUMMARY:")) ||
          l.startsWith(" "),
      );
    // Every line is ≤75 octets (the first SUMMARY line includes its property name).
    for (const l of body.split("\r\n")) {
      expect(Buffer.from(l, "utf8").length).toBeLessThanOrEqual(75);
    }
    // The folded continuation lines start with a single space.
    const folded = body.split("\r\n").filter((l) => l.startsWith(" "));
    expect(folded.length).toBeGreaterThan(0);
    // Sanity: unfolding (drop the leading space on continuation lines)
    // recovers the original "x" string.
    const idx = body.split("\r\n").findIndex((l) => l.startsWith("SUMMARY:"));
    let collected = body.split("\r\n")[idx]!.slice("SUMMARY:".length);
    let j = idx + 1;
    while (j < body.split("\r\n").length && body.split("\r\n")[j]!.startsWith(" ")) {
      collected += body.split("\r\n")[j]!.slice(1);
      j += 1;
    }
    expect(collected).toBe(long);
    void summaryLines;
  });

  it("includes Google Meet X-property when conference.provider is google-meet", () => {
    const { body } = composeIcs(
      {
        ...baseEvent,
        url: "https://meet.google.com/abc-defg-hij",
        conference: {
          provider: "google-meet",
          joinUrl: "https://meet.google.com/abc-defg-hij",
        },
      },
      "REQUEST",
    );
    expect(body).toContain("URL:https://meet.google.com/abc-defg-hij");
    expect(body).toContain("X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij");
  });

  it("includes Teams X-properties when conference.provider is ms-teams", () => {
    const url = "https://teams.microsoft.com/l/meetup-join/abc";
    const { body } = composeIcs(
      {
        ...baseEvent,
        url,
        conference: { provider: "ms-teams", joinUrl: url },
      },
      "REQUEST",
    );
    const u = unfold(body);
    expect(u).toContain(`URL:${url}`);
    expect(u).toContain(`X-MICROSOFT-SKYPETEAMSMEETINGURL:${url}`);
    expect(u).toContain(`X-MICROSOFT-ONLINEMEETINGCONFLINK:${url}`);
  });
});
