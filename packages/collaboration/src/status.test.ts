import { describe, expect, it } from "vitest";
import { assertTransition, canTransition } from "./status.js";

describe("status workflow", () => {
  it("allows open → resolved", () => expect(canTransition("open", "resolved")).toBe(true));
  it("forbids snoozed → snoozed only as a no-op via assertTransition", () => {
    expect(() => assertTransition("snoozed", "snoozed")).not.toThrow();
  });
  it("forbids resolved → snoozed", () => {
    expect(canTransition("resolved", "snoozed")).toBe(false);
    expect(() => assertTransition("resolved", "snoozed")).toThrow();
  });
});
