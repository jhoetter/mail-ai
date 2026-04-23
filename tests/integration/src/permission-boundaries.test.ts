// Permission boundaries — RBAC must reject unauthorized actors at the
// command boundary BEFORE any handler runs, and inbox membership must
// intersect with tenant role.

import { describe, it, expect } from "vitest";
import { assertCan, assertCanInInbox, can, canInInbox } from "@mailai/collaboration";

describe("permission boundaries", () => {
  it("read-only tenant role cannot mutate, even as inbox-admin", () => {
    expect(canInInbox("read-only", "inbox-admin", "thread.set-status")).toBe(false);
    expect(() => assertCan("read-only", "thread.write")).toThrow();
  });

  it("admin tenant role + viewer inbox role cannot write to that inbox", () => {
    expect(canInInbox("admin", "viewer", "thread.assign")).toBe(false);
    expect(() => assertCanInInbox("admin", "viewer", "comment.add")).toThrow(/lacks capability/);
  });

  it("member + agent can comment + assign + set-status", () => {
    expect(canInInbox("member", "agent", "comment.add")).toBe(true);
    expect(canInInbox("member", "agent", "thread.assign")).toBe(true);
    expect(canInInbox("member", "agent", "thread.set-status")).toBe(true);
  });

  it("non-member of an inbox is denied even with admin tenant role", () => {
    expect(canInInbox("admin", null, "thread.read")).toBe(false);
    expect(() => assertCanInInbox("admin", null, "thread.read")).toThrow();
  });

  it("settings.write is tenant-level only and never inbox-scoped to non-admins", () => {
    expect(can("admin", "settings.write")).toBe(true);
    expect(can("member", "settings.write")).toBe(false);
  });
});
