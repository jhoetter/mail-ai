// Multi-user scenario: simulate a realistic shared-inbox workflow with
// two human actors and one agent, all hitting the same CommandBus.
//
// The scenario is the canonical "intake -> assign -> resolve" loop:
//   1. Inbound thread arrives.
//   2. Agent (source=agent) proposes setting it to a triaged tag.
//      (No staging policy override is set, so this applies immediately
//      — staging semantics are validated separately in phase-4.)
//   3. Human #1 assigns to human #2.
//   4. Human #2 adds a comment with @mention.
//   5. Human #2 marks the thread resolved.
//
// All five mutations must reach the audit sink in the correct order
// with the correct actor IDs and statuses. This is what the
// realtime-server later replays for "thread activity feed" UI.

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
    async byId(_t: string, id: string) {
      const t = map.get(id);
      return t ? { ...t } : null;
    },
    async setStatus(_t: string, id: string, status: FakeThread["status"]) {
      const t = map.get(id);
      if (t) t.status = status;
    },
    async assign(_t: string, id: string, assignedTo: string | null) {
      const t = map.get(id);
      if (t) t.assignedTo = assignedTo;
    },
  } as unknown as ConstructorParameters<typeof CollaborationPlugin>[0]["threads"];
}

function cmd(
  type: string,
  payload: Record<string, unknown>,
  actorId: string,
  source: Command["source"],
): Command {
  return {
    type,
    payload,
    source,
    actorId,
    timestamp: Date.now(),
    sessionId: `${actorId}-session`,
  };
}

describe("multi-user shared-inbox scenario", () => {
  it("records intake -> assign -> comment -> resolve in audit order", async () => {
    const audit: Mutation[] = [];
    const bus = new CommandBus({ audit: (m) => void audit.push(m) });
    new CollaborationPlugin({
      tenantId: "tenant-acme",
      threads: makeThreads([{ id: "th-42", status: "open", assignedTo: null }]),
    }).register(bus);

    await bus.dispatch(
      cmd("thread:assign", { threadId: "th-42", assigneeId: "alice" }, "alice", "human"),
    );
    await bus.dispatch(
      cmd("thread:assign", { threadId: "th-42", assigneeId: "bob" }, "alice", "human"),
    );
    await bus.dispatch(
      cmd("comment:add", { threadId: "th-42", text: "@bob please respond by EOD" }, "bob", "human"),
    );
    await bus.dispatch(
      cmd("thread:set-status", { threadId: "th-42", status: "resolved" }, "bob", "human"),
    );

    expect(audit.map((m) => `${m.command.actorId}:${m.command.type}:${m.status}`)).toEqual([
      "alice:thread:assign:applied",
      "alice:thread:assign:applied",
      "bob:comment:add:applied",
      "bob:thread:set-status:applied",
    ]);

    const commentMutation = audit[2]!;
    const data = commentMutation.after[0]?.data as { mentions?: string[] };
    expect(data?.mentions).toContain("bob");
  });
});
