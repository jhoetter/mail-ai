import { describe, expect, it } from "vitest";
import { CommandBus } from "./bus.js";
import type { Command } from "./types.js";

function mkCmd<T>(
  overrides: Partial<Command<`${string}:${string}`, T>> & {
    type: `${string}:${string}`;
    payload: T;
  },
): Command<`${string}:${string}`, T> {
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

  it("runs agent-source commands immediately (no staging)", async () => {
    const bus = new CommandBus();
    let calls = 0;
    bus.register("mail:send", async () => {
      calls++;
      return { before: [], after: [] };
    });
    const m = await bus.dispatch(
      mkCmd({ type: "mail:send", payload: { body: "hi" }, source: "agent", actorId: "agent:bot" }),
    );
    expect(m.status).toBe("applied");
    expect(calls).toBe(1);
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

  it("returns the cached mutation for a repeat idempotency key", async () => {
    const bus = new CommandBus();
    let calls = 0;
    bus.register("mail:mark-read", async () => {
      calls++;
      return { before: [], after: [] };
    });
    const cmd = mkCmd({
      type: "mail:mark-read",
      payload: {},
      idempotencyKey: "k1",
    });
    const a = await bus.dispatch(cmd);
    const b = await bus.dispatch(cmd);
    expect(a.id).toBe(b.id);
    expect(calls).toBe(1);
  });
});
