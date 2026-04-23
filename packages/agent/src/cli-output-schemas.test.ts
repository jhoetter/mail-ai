// Schema-validates the JSON shapes the CLI prints. Each shape goes
// through its zod schema; failure here means the CLI is no longer
// safe to pipe into other tools.

import { describe, expect, it } from "vitest";
import {
  ApplyResultOutputSchema,
  ErrorOutputSchema,
  MutationOutputSchema,
  WhoamiOutputSchema,
} from "./cli-output-schemas.js";

const sampleMutation = {
  id: "m1",
  status: "applied" as const,
  command: { type: "thread:assign", actorId: "u1", timestamp: 1 },
  createdAt: 1,
};

describe("cli-output-schemas", () => {
  it("MutationOutputSchema accepts a sample mutation", () => {
    expect(MutationOutputSchema.parse(sampleMutation)).toEqual(sampleMutation);
  });
  it("ApplyResultOutputSchema accepts ok=true wrapper", () => {
    expect(ApplyResultOutputSchema.parse({ ok: true, mutation: sampleMutation })).toBeTruthy();
  });
  it("WhoamiOutputSchema requires the three identity fields", () => {
    expect(() => WhoamiOutputSchema.parse({ userId: "u" })).toThrow();
    expect(WhoamiOutputSchema.parse({ userId: "u", tenantId: "t", displayName: "D" })).toBeTruthy();
  });
  it("ErrorOutputSchema accepts the standard error envelope", () => {
    expect(ErrorOutputSchema.parse({ error: "auth_error", message: "no token" })).toBeTruthy();
  });
  it("rejects bogus status values", () => {
    expect(() => MutationOutputSchema.parse({ ...sampleMutation, status: "bogus" })).toThrow();
  });
});
