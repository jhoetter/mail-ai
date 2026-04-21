// Batch atomicity tests for MailAgent.applyCommands. The contract
// (`spec/agent/batch-atomicity.md`) is: per-command durability, no
// global rollback, optional short-circuit on failure.

import { describe, expect, it } from "vitest";
import { CommandBus } from "@mailai/core";
import { MailAgent } from "./agent.js";

function bus(): CommandBus {
  const b = new CommandBus();
  b.register("thread:set-status", async (cmd) => {
    const payload = cmd.payload as { threadId: string; status: string };
    if (payload.threadId === "boom") throw new Error("nope");
    return {
      before: [{ kind: "thread", id: payload.threadId, version: 1, data: { status: "open" } }],
      after: [{ kind: "thread", id: payload.threadId, version: 2, data: { status: payload.status } }],
    };
  });
  return b;
}

describe("applyCommands batch semantics", () => {
  it("returns applied results in order with appliedCount", async () => {
    const agent = new MailAgent({
      bus: bus(),
      identity: { userId: "u1", tenantId: "t1", displayName: "u" },
    });
    const out = await agent.applyCommands([
      { type: "thread:set-status", payload: { threadId: "a", status: "resolved" } },
      { type: "thread:set-status", payload: { threadId: "b", status: "open" } },
    ]);
    expect(out.appliedCount).toBe(2);
    expect(out.failedAt).toBeUndefined();
    expect(out.abortedRest).toBe(false);
    expect(out.results.map((r) => r.status)).toEqual(["applied", "applied"]);
  });

  it("short-circuits the rest on failure when stopOnError=true", async () => {
    const agent = new MailAgent({
      bus: bus(),
      identity: { userId: "u1", tenantId: "t1", displayName: "u" },
    });
    const out = await agent.applyCommands([
      { type: "thread:set-status", payload: { threadId: "a", status: "resolved" } },
      { type: "thread:set-status", payload: { threadId: "boom", status: "resolved" } },
      { type: "thread:set-status", payload: { threadId: "c", status: "resolved" } },
    ]);
    expect(out.appliedCount).toBe(1);
    expect(out.failedAt).toBe(1);
    expect(out.abortedRest).toBe(true);
    expect(out.results[2]?.status).toBe("skipped");
  });

  it("continues past failures when stopOnError=false", async () => {
    const agent = new MailAgent({
      bus: bus(),
      identity: { userId: "u1", tenantId: "t1", displayName: "u" },
    });
    const out = await agent.applyCommands(
      [
        { type: "thread:set-status", payload: { threadId: "a", status: "resolved" } },
        { type: "thread:set-status", payload: { threadId: "boom", status: "resolved" } },
        { type: "thread:set-status", payload: { threadId: "c", status: "resolved" } },
      ],
      { stopOnError: false },
    );
    expect(out.appliedCount).toBe(2);
    expect(out.abortedRest).toBe(false);
    expect(out.results[1]?.status).toBe("failed");
    expect(out.results[2]?.status).toBe("applied");
  });
});
