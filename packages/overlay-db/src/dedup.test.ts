import { describe, expect, it } from "vitest";
import { syntheticMessageId } from "./dedup.js";

describe("syntheticMessageId", () => {
  it("is deterministic for the same input", () => {
    const seed = {
      date: new Date("2026-04-21T10:00:00Z"),
      from: [{ address: "a@x.com" }],
      subject: "hello",
      to: [{ address: "b@y.com" }],
    };
    expect(syntheticMessageId(seed)).toBe(syntheticMessageId(seed));
  });

  it("changes when subject changes", () => {
    const a = syntheticMessageId({
      date: new Date(0),
      from: [{ address: "a@x" }],
      subject: "1",
      to: [{ address: "b@y" }],
    });
    const b = syntheticMessageId({
      date: new Date(0),
      from: [{ address: "a@x" }],
      subject: "2",
      to: [{ address: "b@y" }],
    });
    expect(a).not.toBe(b);
  });

  it("normalises addresses to lower case", () => {
    const a = syntheticMessageId({
      date: new Date(0),
      from: [{ address: "A@X.com" }],
      subject: "x",
      to: [{ address: "B@y.com" }],
    });
    const b = syntheticMessageId({
      date: new Date(0),
      from: [{ address: "a@x.com" }],
      subject: "x",
      to: [{ address: "b@y.com" }],
    });
    expect(a).toBe(b);
  });
});
