import { describe, expect, it } from "vitest";
import { CommandBus } from "./bus.js";
import type { Command } from "./types.js";

function mkCmd<T>(overrides: Partial<Command<`${string}:${string}`, T>> & { type: `${string}:${string}`; payload: T }): Command<`${string}:${string}`, T> {
  return {
    source: "human",
    actorId: "u_1",
    timestamp: 1,
    sessionId: "s_1",
    ...overrides,
  };
}

describe("CommandBus", () => {
  it("dispatches a registered handler and records mutation diffs", async () => {
    const bus = new CommandBus({ now: () => 100 });
    bus.register("mail:mark-read", async () => ({
      before: [{ kind: "thread", id: "t1", version: 1, data: { unread: true } }],
      after: [{ kind: "thread", id: "t1", version: 2, data: { unread: false } }],
    }));
    const m = await bus.dispatch(mkCmd({ type: "mail:mark-read", payload: { threadId: "t1" } }));
    expect(m.status).toBe("applied");
    expect(m.diffs).toHaveLength(1);
    expect(m.diffs[0]!.ops).toEqual([{ op: "set", path: "unread", value: false }]);
  });

  it("stages agent-source commands for approval-required types", async () => {
    const bus = new CommandBus();
    bus.register("mail:send", async () => ({ before: [], after: [] }));
    const m = await bus.dispatch(
      mkCmd({ type: "mail:send", payload: { body: "hi" }, source: "agent", actorId: "agent:bot" }),
    );
    expect(m.status).toBe("pending");
    const pending = await bus.listPending();
    expect(pending).toHaveLength(1);
  });

  it("auto-applies agent commands flagged as 'auto' policy", async () => {
    const bus = new CommandBus();
    bus.register("mail:mark-read", async () => ({ before: [], after: [] }));
    const m = await bus.dispatch(
      mkCmd({ type: "mail:mark-read", payload: {}, source: "agent", actorId: "agent:bot" }),
    );
    expect(m.status).toBe("applied");
  });

  it("approve runs the handler and marks mutation applied", async () => {
    const bus = new CommandBus();
    bus.register("mail:send", async () => ({
      before: [{ kind: "thread", id: "t1", version: 1, data: { sent: false } }],
      after: [{ kind: "thread", id: "t1", version: 2, data: { sent: true } }],
    }));
    const staged = await bus.dispatch(
      mkCmd({ type: "mail:send", payload: { to: "x@x" }, source: "agent", actorId: "agent:bot" }),
    );
    const approved = await bus.approve(staged.id, "u_human");
    expect(approved.status).toBe("applied");
    expect(approved.approvedBy).toBe("u_human");
    expect(approved.diffs[0]!.ops).toContainEqual({ op: "set", path: "sent", value: true });
  });

  it("captures handler failure as a failed mutation", async () => {
    const bus = new CommandBus();
    bus.register("mail:reply", async () => {
      throw new Error("imap down");
    });
    const m = await bus.dispatch(mkCmd({ type: "mail:reply", payload: {} }));
    expect(m.status).toBe("failed");
    expect(m.error?.message).toBe("imap down");
  });
});
