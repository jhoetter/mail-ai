import { describe, expect, it } from "vitest";
import { can, canInInbox, assertCan, assertCanInInbox } from "./rbac.js";

describe("rbac", () => {
  it("tenant role gates global capabilities", () => {
    expect(can("admin", "thread.set-status")).toBe(true);
    expect(can("read-only", "thread.set-status")).toBe(false);
  });

  it("inbox role intersects with tenant role", () => {
    expect(canInInbox("admin", "viewer", "thread.set-status")).toBe(false);
    expect(canInInbox("admin", "agent", "thread.set-status")).toBe(true);
    expect(canInInbox("read-only", "inbox-admin", "thread.set-status")).toBe(false);
  });

  it("denies when inbox role is missing", () => {
    expect(canInInbox("admin", null, "thread.read")).toBe(false);
  });

  it("assert variants throw on denial", () => {
    expect(() => assertCan("read-only", "thread.write")).toThrow(/lacks/);
    expect(() => assertCanInInbox("admin", "viewer", "thread.write")).toThrow(/lacks/);
  });
});
