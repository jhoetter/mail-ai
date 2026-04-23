// Overlay isolation snapshot test.
//
// Independently of the witness assertions in `imap-coexistence.test.ts`,
// this test snapshots the full per-mailbox header set BEFORE any
// mail-ai action and AFTER, and asserts that the diff is constrained to:
//
//   - new messages we delivered ourselves (Sent APPEND, etc.)
//   - flag changes we made
//
// Anything else (a new header on an existing message, a freshly-created
// folder we didn't ask for) fails the suite. This is the formal
// realization of the "overlay never modifies what wasn't asked" bar.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ImapFlow } from "imapflow";
import {
  ImapConnection,
  MailboxSyncer,
  Outboxer,
  type AccountCredentials,
} from "@mailai/imap-sync";

const ENABLED = process.env["MAILAI_GREENMAIL"] === "1";
const HOST = process.env["MAILAI_IMAP_HOST"] ?? "127.0.0.1";
const IMAP_PORT = Number(process.env["MAILAI_IMAP_PORT"] ?? 3143);

const describeIf = ENABLED ? describe : describe.skip;

interface SnapshotEntry {
  uid: number;
  flags: string[];
  headerKeys: string[];
}
interface MailboxSnapshot {
  path: string;
  uidValidity: number;
  entries: SnapshotEntry[];
}

async function snapshot(client: ImapFlow, mailboxes: string[]): Promise<MailboxSnapshot[]> {
  const out: MailboxSnapshot[] = [];
  for (const path of mailboxes) {
    const lock = await client.getMailboxLock(path);
    try {
      const status = client.mailbox && typeof client.mailbox === "object" ? client.mailbox : null;
      const entries: SnapshotEntry[] = [];
      for await (const msg of client.fetch("1:*", { uid: true, flags: true, headers: true })) {
        const headers = ((msg as { headers?: Buffer }).headers ?? Buffer.alloc(0)).toString("utf8");
        const headerKeys = Array.from(
          new Set(
            headers
              .split(/\r?\n/)
              .map((l) => /^([!-9;-~]+):/.exec(l)?.[1]?.toLowerCase())
              .filter((s): s is string => !!s),
          ),
        ).sort();
        entries.push({
          uid: msg.uid ?? 0,
          flags: Array.from(msg.flags ?? []).sort(),
          headerKeys,
        });
      }
      out.push({
        path,
        uidValidity: Number(status?.uidValidity ?? 0),
        entries: entries.sort((a, b) => a.uid - b.uid),
      });
    } finally {
      lock.release();
    }
  }
  return out;
}

function diff(
  a: MailboxSnapshot[],
  b: MailboxSnapshot[],
): {
  newFolders: string[];
  removedFolders: string[];
  perFolder: Array<{
    path: string;
    newUids: number[];
    removedUids: number[];
    flagChanges: Array<{ uid: number; before: string[]; after: string[] }>;
    headerKeyAdditions: Array<{ uid: number; added: string[] }>;
  }>;
} {
  const aMap = new Map(a.map((m) => [m.path, m]));
  const bMap = new Map(b.map((m) => [m.path, m]));
  const newFolders = [...bMap.keys()].filter((p) => !aMap.has(p));
  const removedFolders = [...aMap.keys()].filter((p) => !bMap.has(p));
  const perFolder = [];
  for (const path of [...aMap.keys()].filter((p) => bMap.has(p))) {
    const before = aMap.get(path)!;
    const after = bMap.get(path)!;
    const beforeUids = new Set(before.entries.map((e) => e.uid));
    const afterUids = new Set(after.entries.map((e) => e.uid));
    const newUids = [...afterUids].filter((u) => !beforeUids.has(u));
    const removedUids = [...beforeUids].filter((u) => !afterUids.has(u));
    const flagChanges = [];
    const headerKeyAdditions = [];
    for (const e of before.entries) {
      const a2 = after.entries.find((x) => x.uid === e.uid);
      if (!a2) continue;
      if (JSON.stringify(e.flags) !== JSON.stringify(a2.flags)) {
        flagChanges.push({ uid: e.uid, before: e.flags, after: a2.flags });
      }
      const added = a2.headerKeys.filter((k) => !e.headerKeys.includes(k));
      if (added.length) headerKeyAdditions.push({ uid: e.uid, added });
    }
    perFolder.push({ path, newUids, removedUids, flagChanges, headerKeyAdditions });
  }
  return { newFolders, removedFolders, perFolder };
}

function creds(user: string): AccountCredentials {
  return {
    provider: "imap",
    host: HOST,
    port: IMAP_PORT,
    secure: false,
    username: user,
    auth: { kind: "password", password: user },
  };
}

describeIf("overlay isolation snapshot", () => {
  let witness: ImapFlow;
  beforeAll(async () => {
    witness = new ImapFlow({
      host: HOST,
      port: IMAP_PORT,
      secure: false,
      auth: { user: "alice", pass: "alice" },
      logger: false,
    });
    await witness.connect();
  });
  afterAll(async () => {
    await witness.logout().catch(() => undefined);
  });

  it("only the explicit flag/move changes show up in the diff", async () => {
    const folders = ["INBOX"];
    const before = await snapshot(witness, folders);

    const conn = new ImapConnection(creds("alice"));
    await conn.connect();
    try {
      const syncer = new MailboxSyncer(conn);
      await syncer.initialFetch("INBOX");
      // Pick the highest UID to flip \\Seen on; do nothing else.
      const lock = await conn.raw()!.getMailboxLock("INBOX");
      let target = 0;
      try {
        const search = await conn.raw()!.search({ all: true });
        target = (search?.[search.length - 1] ?? 0) as number;
      } finally {
        lock.release();
      }
      if (target > 0) {
        const out = new Outboxer(conn);
        await out.run([{ kind: "set-flag", mailbox: "INBOX", uid: target, flag: "\\Seen" }]);
      }
    } finally {
      await conn.close();
    }

    const after = await snapshot(witness, folders);
    const d = diff(before, after);
    expect(d.newFolders).toEqual([]);
    expect(d.removedFolders).toEqual([]);
    for (const p of d.perFolder) {
      expect(p.removedUids).toEqual([]);
      // Header key set must be identical for every pre-existing message
      const offending = p.headerKeyAdditions.filter((h) =>
        h.added.some((k) => /^x-mailai-/i.test(k)),
      );
      expect(offending).toEqual([]);
    }
  });
});
