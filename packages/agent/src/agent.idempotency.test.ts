// Idempotency: same (actor, type, key) returns the cached mutation.

import { describe, expect, it } from "vitest";
import { CommandBus } from "@mailai/core";
import { MailAgent } from "./agent.js";

describe("idempotency", () => {
  it("returns the same mutation for repeated dispatch with the same key", async () => {
    let calls = 0;
    const bus = new CommandBus();
    bus.register("thread:set-status", async () => {
      calls++;
      return {
        before: [{ kind: "thread", id: "t1", version: 1, data: { status: "open" } }],
        after: [{ kind: "thread", id: "t1", version: 2, data: { status: "resolved" } }],
      };
    });
    const agent = new MailAgent({
      bus,
      identity: { userId: "u1", tenantId: "t1", displayName: "U" },
    });
    const a = await agent.applyCommand({
      type: "thread:set-status",
      payload: { threadId: "t1", status: "resolved" },
      idempotencyKey: "k1",
    });
    const b = await agent.applyCommand({
      type: "thread:set-status",
      payload: { threadId: "t1", status: "resolved" },
      idempotencyKey: "k1",
    });
    expect(b.id).toBe(a.id);
    expect(calls).toBe(1);
  });

  it("different keys produce different mutations", async () => {
    const bus = new CommandBus();
    bus.register("thread:set-status", async () => ({
      before: [{ kind: "thread", id: "t1", version: 1, data: { status: "open" } }],
      after: [{ kind: "thread", id: "t1", version: 2, data: { status: "resolved" } }],
    }));
    const agent = new MailAgent({
      bus,
      identity: { userId: "u1", tenantId: "t1", displayName: "U" },
    });
    const a = await agent.applyCommand({
      type: "thread:set-status",
      payload: { threadId: "t1", status: "resolved" },
      idempotencyKey: "k1",
    });
    const b = await agent.applyCommand({
      type: "thread:set-status",
      payload: { threadId: "t1", status: "resolved" },
      idempotencyKey: "k2",
    });
    expect(b.id).not.toBe(a.id);
  });
});
