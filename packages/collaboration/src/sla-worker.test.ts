import { describe, expect, it, vi } from "vitest";
import { runSlaTick } from "./sla-worker.js";

describe("runSlaTick", () => {
  it("emits sla:overdue for open threads past their target", async () => {
    const events: { type: string; threadId: string; minutesElapsed: number }[] = [];
    const issued: unknown[] = [];
    const now = new Date("2024-01-01T01:00:00Z");
    const out = await runSlaTick({
      loadOpenThreads: async () => [
        {
          threadId: "t1",
          inboxId: "i1",
          lastInboundAt: new Date("2024-01-01T00:00:00Z"),
          lastOutboundAt: null,
          status: "open",
        },
      ],
      loadSnoozedThreads: async () => [],
      loadPolicies: async () => [{ inboxId: "i1", responseTargetMinutes: 30 }],
      events: { emit: (e) => events.push(e) },
      issuer: { issue: async (c) => void issued.push(c) },
      now: () => now,
    });
    expect(out.overdue).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "sla:overdue", threadId: "t1" });
    expect(issued).toHaveLength(0);
  });

  it("auto-reopens snoozed threads whose timer elapsed", async () => {
    const issue = vi.fn().mockResolvedValue(undefined);
    const now = new Date("2024-01-01T05:00:00Z");
    const out = await runSlaTick({
      loadOpenThreads: async () => [],
      loadSnoozedThreads: async () => [
        { threadId: "t9", snoozedUntil: new Date("2024-01-01T04:00:00Z") },
        { threadId: "t10", snoozedUntil: new Date("2024-01-01T06:00:00Z") },
      ],
      loadPolicies: async () => [],
      events: { emit: () => {} },
      issuer: { issue },
      now: () => now,
    });
    expect(out.reopened).toEqual(["t9"]);
    expect(issue).toHaveBeenCalledOnce();
    expect(issue.mock.calls[0][0]).toMatchObject({
      type: "thread:set-status",
      threadId: "t9",
      status: "open",
      actorId: "system:sla-worker",
    });
  });
});
