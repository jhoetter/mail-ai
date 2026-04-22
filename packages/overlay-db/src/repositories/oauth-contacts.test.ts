import { describe, expect, it } from "vitest";
import { escapeLike } from "./oauth-contacts.js";

describe("escapeLike", () => {
  it("passes through plain text", () => {
    expect(escapeLike("alice")).toBe("alice");
    expect(escapeLike("alice@example.com")).toBe("alice@example.com");
  });

  it("escapes the SQL wildcard characters", () => {
    expect(escapeLike("100%")).toBe("100\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
  });

  it("escapes the escape character itself", () => {
    expect(escapeLike("a\\b")).toBe("a\\\\b");
  });

  it("escapes mixed input deterministically", () => {
    expect(escapeLike("a\\_b%c")).toBe("a\\\\\\_b\\%c");
  });

  it("leaves the empty string unchanged", () => {
    expect(escapeLike("")).toBe("");
  });
});
