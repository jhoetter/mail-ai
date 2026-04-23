// Unit coverage for the locally-mirrored "Sent" row that mail:send /
// mail:reply / mail:forward write into oauth_messages right after
// the provider call returns. The actual upsert is covered by the
// repository's own integration tests; here we only assert the row
// contents are shaped so the views.ts Sent filter picks them up
// immediately (wellKnownFolder='sent', unread is false, the from-
// address is the connected account, etc.).

import { describe, expect, it } from "vitest";
import { buildSentMirrorRow } from "./mail-send.js";

describe("buildSentMirrorRow", () => {
  const baseInput = {
    tenantId: "tenant_dev",
    accountId: "acc_1",
    accountEmail: "alice@example.com",
    accountProvider: "google-mail" as const,
    providerMessageId: "prov_msg_1",
    providerThreadId: "prov_thread_1",
    subject: "Hello",
    to: ["bob@example.com"],
    snippet: "Quick note about the demo.",
    sentAt: new Date("2026-04-22T12:00:00Z"),
  };

  it("tags the row as wellKnownFolder='sent' so the Sent view picks it up immediately", () => {
    const row = buildSentMirrorRow(baseInput);
    expect(row.wellKnownFolder).toBe("sent");
    expect(row.labelsJson).toEqual([]);
  });

  it("flags the row as already-read (sender authored it)", () => {
    const row = buildSentMirrorRow(baseInput);
    expect(row.unread).toBe(false);
  });

  it("attributes the row to the connected account, not the recipients", () => {
    const row = buildSentMirrorRow(baseInput);
    expect(row.fromEmail).toBe("alice@example.com");
    expect(row.fromName).toBe(null);
    expect(row.toAddr).toBe("bob@example.com");
  });

  it("works for Outlook accounts too (no Gmail-specific assumptions)", () => {
    const row = buildSentMirrorRow({ ...baseInput, accountProvider: "outlook" });
    expect(row.provider).toBe("outlook");
    expect(row.wellKnownFolder).toBe("sent");
  });

  it("collapses multiple recipients into a single comma-separated to_addr field", () => {
    const row = buildSentMirrorRow({
      ...baseInput,
      to: ["bob@example.com", "carol@example.com", "dan@example.com"],
    });
    expect(row.toAddr).toBe("bob@example.com, carol@example.com, dan@example.com");
  });

  it("uses the supplied internal date so the row sorts to the top of Sent immediately", () => {
    const sentAt = new Date("2026-04-22T13:37:42Z");
    const row = buildSentMirrorRow({ ...baseInput, sentAt });
    expect(row.internalDate.toISOString()).toBe(sentAt.toISOString());
  });

  it("issues a fresh om_ prefixed id for every call (id collisions break ON CONFLICT)", () => {
    const a = buildSentMirrorRow(baseInput);
    const b = buildSentMirrorRow(baseInput);
    expect(a.id.startsWith("om_")).toBe(true);
    expect(b.id.startsWith("om_")).toBe(true);
    expect(a.id).not.toBe(b.id);
  });
});
