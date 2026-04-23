// Audit completeness — every successful CommandBus mutation MUST surface
// to the audit sink with non-empty before/after for entity-mutating
// commands. The audit sink is the single source of truth for the
// collaboration domain (per `spec/collaboration/audit-log.md`); a
// regression here would silently break compliance export and replay.

import { describe, it, expect } from "vitest";
import { CommandBus, type Command, type Mutation } from "@mailai/core";
import { CollaborationPlugin } from "@mailai/collaboration";

interface FakeThread {
  id: string;
  status: "open" | "snoozed" | "resolved" | "archived";
  assignedTo: string | null;
}

function makeThreads(seed: FakeThread[]) {
  const map = new Map(seed.map((t) => [t.id, { ...t }]));
  return {
    async byId(_tenantId: string, id: string) {
      const t = map.get(id);
      return t ? { ...t } : null;
    },
    async setStatus(_tenantId: string, id: string, status: FakeThread["status"]) {
      const t = map.get(id);
      if (t) t.status = status;
    },
    async assign(_tenantId: string, id: string, assignedTo: string | null) {
      const t = map.get(id);
      if (t) t.assignedTo = assignedTo;
    },
  } as unknown as ConstructorParameters<typeof CollaborationPlugin>[0]["threads"];
}

describe("audit completeness", () => {
  it("every collaboration mutation reaches the audit sink with diffs", async () => {
    const audit: Mutation[] = [];
    const bus = new CommandBus({ audit: (m) => void audit.push(m) });
    const plugin = new CollaborationPlugin({
      tenantId: "t1",
      threads: makeThreads([{ id: "th1", status: "open", assignedTo: null }]),
    });
    plugin.register(bus);

    const baseCmd = (type: `${string}:${string}`, payload: Record<string, unknown>): Command => ({
      type,
      payload,
      source: "human",
      actorId: "user1",
      timestamp: 1,
      sessionId: "s1",
    });

    await bus.dispatch(baseCmd("thread:assign", { threadId: "th1", assigneeId: "user2" }));
    await bus.dispatch(baseCmd("thread:set-status", { threadId: "th1", status: "resolved" }));
    await bus.dispatch(baseCmd("thread:unassign", { threadId: "th1" }));

    expect(audit).toHaveLength(3);
    for (const m of audit) {
      expect(m.status).toBe("applied");
      expect(m.before.length).toBe(m.after.length);
      expect(m.diffs.length).toBeGreaterThan(0);
      expect(m.command.actorId).toBe("user1");
    }

    const ops = audit.flatMap((m) =>
      m.diffs.flatMap((d) => d.ops as unknown as Array<{ path: string }>),
    );
    const paths = ops.map((o) => o.path).sort();
    expect(paths).toContain("status");
    expect(paths).toContain("assignedTo");
  });

  it("failed handlers still emit an audit entry with status=failed", async () => {
    const audit: Mutation[] = [];
    const bus = new CommandBus({ audit: (m) => void audit.push(m) });
    const plugin = new CollaborationPlugin({
      tenantId: "t1",
      threads: makeThreads([]),
    });
    plugin.register(bus);

    const m = await bus.dispatch({
      type: "thread:set-status",
      payload: { threadId: "missing", status: "resolved" },
      source: "human",
      actorId: "user1",
      timestamp: 1,
      sessionId: "s1",
    } as Command);
    expect(m.status).toBe("failed");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.error?.message).toMatch(/not found/);
  });
});
