// Staging semantics: agent-source `mail:send` MUST land as `pending`,
// then `approveMutation` re-executes the handler and applies the
// mutation with `approvedBy` recorded. Humans never stage.

import { describe, expect, it } from "vitest";
import { CommandBus } from "@mailai/core";
import { MailAgent } from "./agent.js";

function bus(): { bus: CommandBus; calls: () => number } {
  let calls = 0;
  const b = new CommandBus();
  b.register("mail:send", async () => {
    calls++;
    return {
      before: [],
      after: [
        {
          kind: "message",
          id: "m1",
          version: 1,
          data: { to: ["x@example.com"], subject: "hi" },
        },
      ],
      imapSideEffects: [{ kind: "smtp-submit", accountId: "a1", messageId: "m1" }],
    };
  });
  return { bus: b, calls: () => calls };
}

const SEND = {
  type: "mail:send" as const,
  payload: { to: ["x@example.com"], subject: "hi", body: "hello" },
};

describe("staging semantics", () => {
  it("agent-source mail:send is staged as pending and does not run the handler", async () => {
    const { bus: b, calls } = bus();
    const agent = new MailAgent({
      bus: b,
      identity: { userId: "agent-1", tenantId: "t1", displayName: "Agent" },
      source: "agent",
    });
    const m = await agent.applyCommand(SEND);
    expect(m.status).toBe("pending");
    expect(m.imapSideEffects).toEqual([]);
    expect(calls()).toBe(0);
  });

  it("approveMutation re-executes the handler and records approvedBy", async () => {
    const { bus: b, calls } = bus();
    const agent = new MailAgent({
      bus: b,
      identity: { userId: "agent-1", tenantId: "t1", displayName: "Agent" },
      source: "agent",
    });
    const human = new MailAgent({
      bus: b,
      identity: { userId: "human-1", tenantId: "t1", displayName: "Op" },
      source: "human",
    });
    const staged = await agent.applyCommand(SEND);
    const approved = await human.approveMutation(staged.id);
    expect(approved.status).toBe("applied");
    expect(approved.approvedBy).toBe("human-1");
    expect(approved.imapSideEffects.length).toBe(1);
    expect(calls()).toBe(1);
  });

  it("rejectMutation flips status to rejected without running the handler", async () => {
    const { bus: b, calls } = bus();
    const agent = new MailAgent({
      bus: b,
      identity: { userId: "agent-1", tenantId: "t1", displayName: "Agent" },
      source: "agent",
    });
    const human = new MailAgent({
      bus: b,
      identity: { userId: "human-1", tenantId: "t1", displayName: "Op" },
      source: "human",
    });
    const staged = await agent.applyCommand(SEND);
    const rejected = await human.rejectMutation(staged.id, "spammy");
    expect(rejected.status).toBe("rejected");
    expect(rejected.rejectedReason).toBe("spammy");
    expect(calls()).toBe(0);
  });

  it("human-source mail:send applies immediately", async () => {
    const { bus: b, calls } = bus();
    const human = new MailAgent({
      bus: b,
      identity: { userId: "human-1", tenantId: "t1", displayName: "Op" },
      source: "human",
    });
    const m = await human.applyCommand(SEND);
    expect(m.status).toBe("applied");
    expect(calls()).toBe(1);
  });
});
