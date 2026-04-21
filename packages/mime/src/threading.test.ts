import { describe, expect, it } from "vitest";
import { thread } from "./threading.js";

describe("JWZ threading", () => {
  it("groups a simple reply chain under one root", () => {
    const roots = thread([
      { messageId: "<a@x>", inReplyTo: [], references: [] },
      { messageId: "<b@x>", inReplyTo: ["<a@x>"], references: ["<a@x>"] },
      { messageId: "<c@x>", inReplyTo: ["<b@x>"], references: ["<a@x>", "<b@x>"] },
    ]);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.messageId).toBe("<a@x>");
    expect(roots[0]!.children).toHaveLength(1);
    expect(roots[0]!.children[0]!.messageId).toBe("<b@x>");
    expect(roots[0]!.children[0]!.children[0]!.messageId).toBe("<c@x>");
  });

  it("creates ghost containers for missing parents and prunes them", () => {
    // Reply references a parent we never received.
    const roots = thread([{ messageId: "<b@x>", inReplyTo: ["<a@x>"], references: ["<a@x>"] }]);
    expect(roots).toHaveLength(1);
    // The ghost <a@x> has only one real child → collapsed to that child.
    expect(roots[0]!.messageId).toBe("<b@x>");
  });

  it("treats two unrelated messages as two threads", () => {
    const roots = thread([
      { messageId: "<a@x>", inReplyTo: [], references: [] },
      { messageId: "<b@y>", inReplyTo: [], references: [] },
    ]);
    expect(roots.map((r) => r.messageId).sort()).toEqual(["<a@x>", "<b@y>"]);
  });
});
