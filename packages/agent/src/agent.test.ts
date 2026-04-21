import { describe, expect, it } from "vitest";
import { CommandBus } from "@mailai/core";
import { MailAgent } from "./agent.js";

describe("MailAgent", () => {
  it("rejects payloads that fail schema validation", async () => {
    const bus = new CommandBus();
    bus.register("thread:set-status", async () => ({ before: [], after: [] }));
    const agent = new MailAgent({
      bus,
      identity: { userId: "u1", tenantId: "t1", displayName: "U" },
    });
    await expect(
      agent.applyCommand({ type: "thread:set-status", payload: { threadId: "t1", status: "foo" } }),
    ).rejects.toMatchObject({ code: "validation_error" });
  });

  it("dispatches valid commands through the bus", async () => {
    const bus = new CommandBus();
    bus.register("thread:set-status", async () => ({
      before: [{ kind: "thread", id: "t1", version: 1, data: { status: "open" } }],
      after: [{ kind: "thread", id: "t1", version: 2, data: { status: "resolved" } }],
    }));
    const agent = new MailAgent({
      bus,
      identity: { userId: "u1", tenantId: "t1", displayName: "U" },
    });
    const m = await agent.applyCommand({
      type: "thread:set-status",
      payload: { threadId: "t1", status: "resolved" },
    });
    expect(m.status).toBe("applied");
  });
});
