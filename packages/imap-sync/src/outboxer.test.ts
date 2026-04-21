import { describe, expect, it, vi } from "vitest";
import { Outboxer, type ImapSideEffect } from "./outboxer.js";

function fakeConn(client: unknown) {
  return { raw: () => client } as unknown as ConstructorParameters<typeof Outboxer>[0];
}

describe("Outboxer", () => {
  it("drives set-flag, unset-flag, move, expunge, append in order", async () => {
    const calls: string[] = [];
    const lock = { release: () => calls.push("release") };
    const client = {
      getMailboxLock: vi.fn(async () => lock),
      messageFlagsAdd: vi.fn(async () => calls.push("set-flag")),
      messageFlagsRemove: vi.fn(async () => calls.push("unset-flag")),
      messageMove: vi.fn(async () => calls.push("move")),
      messageDelete: vi.fn(async () => calls.push("expunge")),
      append: vi.fn(async () => ({ uid: 42 })),
    };
    const effects: ImapSideEffect[] = [
      { kind: "set-flag", mailbox: "INBOX", uid: 1, flag: "\\Seen" },
      { kind: "unset-flag", mailbox: "INBOX", uid: 1, flag: "\\Flagged" },
      { kind: "move", mailbox: "INBOX", uid: 1, toMailbox: "Archive" },
      { kind: "expunge", mailbox: "INBOX", uid: 2 },
      { kind: "append", mailbox: "Sent", raw: Buffer.from("hello") },
    ];
    const out = new Outboxer(fakeConn(client));
    const results = await out.run(effects);
    expect(results.every((r) => r.ok)).toBe(true);
    const append = results[results.length - 1]!;
    expect(append.newUid).toBe(42);
    expect(calls.filter((c) => c === "set-flag")).toHaveLength(1);
    expect(calls.filter((c) => c === "expunge")).toHaveLength(1);
  });

  it("aborts the batch on first failure", async () => {
    const lock = { release: () => undefined };
    const client = {
      getMailboxLock: vi.fn(async () => lock),
      messageFlagsAdd: vi.fn(async () => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      }),
      messageDelete: vi.fn(),
    };
    const out = new Outboxer(fakeConn(client));
    const results = await out.run([
      { kind: "set-flag", mailbox: "INBOX", uid: 1, flag: "\\Seen" },
      { kind: "expunge", mailbox: "INBOX", uid: 2 },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error?.code).toBe("EPERM");
    expect(client.messageDelete).not.toHaveBeenCalled();
  });
});
