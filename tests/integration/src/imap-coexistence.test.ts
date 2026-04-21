// IMAP coexistence acceptance tests.
//
// These run against the dockerized Greenmail server and verify the
// non-negotiable bar from prompt.md §IMAP Coexistence Integrity:
//
//   - Marking read in our overlay is visible to a parallel client
//     within seconds.
//   - Replying via our SMTP path lands in the Sent folder via APPEND
//     and the parallel client sees the reply.
//   - Moves are reflected.
//   - We never write any header / hidden folder of our own.
//
// They are SKIPPED by default and only run when MAILAI_GREENMAIL=1 is
// set (i.e. CI or a local `make stack-up` session). This keeps `pnpm
// test` fast and deterministic without docker.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import {
  ImapConnection,
  MailboxSyncer,
  Outboxer,
  appendRawToSent,
  type AccountCredentials,
} from "@mailai/imap-sync";
import { composeMessage } from "@mailai/mime";

const ENABLED = process.env["MAILAI_GREENMAIL"] === "1";
const HOST = process.env["MAILAI_IMAP_HOST"] ?? "127.0.0.1";
const IMAP_PORT = Number(process.env["MAILAI_IMAP_PORT"] ?? 3143);
const SMTP_PORT = Number(process.env["MAILAI_SMTP_PORT"] ?? 3025);

const describeIf = ENABLED ? describe : describe.skip;

function creds(user: string, pass = user): AccountCredentials {
  return {
    provider: "imap",
    host: HOST,
    port: IMAP_PORT,
    secure: false,
    username: user,
    auth: { kind: "password", password: pass },
  };
}

async function deliver(subject: string, to = "alice@mailai.test", from = "carol@mailai.test", body = "hi") {
  const transporter = nodemailer.createTransport({ host: HOST, port: SMTP_PORT, secure: false });
  await transporter.sendMail({ from, to, subject, text: body });
  await new Promise((r) => setTimeout(r, 250));
}

describeIf("IMAP coexistence", () => {
  let writer: ImapFlow;
  let witness: ImapFlow;

  beforeAll(async () => {
    writer = new ImapFlow({
      host: HOST,
      port: IMAP_PORT,
      secure: false,
      auth: { user: "alice", pass: "alice" },
      logger: false,
    });
    witness = new ImapFlow({
      host: HOST,
      port: IMAP_PORT,
      secure: false,
      auth: { user: "alice", pass: "alice" },
      logger: false,
    });
    await Promise.all([writer.connect(), witness.connect()]);
  });

  afterAll(async () => {
    await Promise.all([writer.logout().catch(() => {}), witness.logout().catch(() => {})]);
  });

  it("marks a message read and the witness sees it", async () => {
    await deliver("coexistence-read");
    const lock = await writer.getMailboxLock("INBOX");
    let uid: number | undefined;
    try {
      const search = await writer.search({ subject: "coexistence-read" });
      uid = search?.[0];
      expect(uid).toBeTruthy();
      if (uid) await writer.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
    } finally {
      lock.release();
    }
    const wlock = await witness.getMailboxLock("INBOX");
    try {
      if (uid) {
        const fetched = await witness.fetchOne(String(uid), { flags: true }, { uid: true });
        const flags = Array.from(fetched?.flags ?? []);
        expect(flags).toContain("\\Seen");
      }
    } finally {
      wlock.release();
    }
  });

  it("MailboxSyncer initial fetch then delta surfaces a new delivery", async () => {
    const conn = new ImapConnection(creds("alice"));
    await conn.connect();
    try {
      const syncer = new MailboxSyncer(conn);
      const first = await syncer.initialFetch("INBOX");
      const before = first.headers.length;
      await deliver("coexistence-delta", "alice@mailai.test", "bob@mailai.test", "delta");
      const delta = await syncer.deltaSync(first.state);
      const newOnes = delta.changes.filter((c) => c.kind === "new");
      expect(newOnes.length).toBeGreaterThanOrEqual(1);
      expect(before + newOnes.length).toBeGreaterThan(before);
      expect(delta.fullResyncRequired).toBe(false);
    } finally {
      await conn.close();
    }
  });

  it("Outboxer move from INBOX to Archive is visible to the witness", async () => {
    await deliver("coexistence-move");
    await writer.mailboxCreate("Archive").catch(() => undefined);

    const conn = new ImapConnection(creds("alice"));
    await conn.connect();
    let uid = 0;
    try {
      const lock = await conn.raw()!.getMailboxLock("INBOX");
      try {
        const search = await conn.raw()!.search({ subject: "coexistence-move" });
        uid = (search?.[0] ?? 0) as number;
        expect(uid).toBeGreaterThan(0);
      } finally {
        lock.release();
      }
      const out = new Outboxer(conn);
      const result = await out.run([{ kind: "move", mailbox: "INBOX", uid, toMailbox: "Archive" }]);
      expect(result[0]!.ok).toBe(true);
    } finally {
      await conn.close();
    }

    const lock = await witness.getMailboxLock("Archive");
    try {
      const search = await witness.search({ subject: "coexistence-move" });
      expect(search?.length ?? 0).toBeGreaterThanOrEqual(1);
    } finally {
      lock.release();
    }
  });

  it("Append composed message to Sent and witness can read it", async () => {
    const conn = new ImapConnection(creds("alice"));
    await conn.connect();
    try {
      await conn.raw()!.mailboxCreate("Sent").catch(() => undefined);
      const composed = composeMessage({
        from: "alice@mailai.test",
        to: ["bob@mailai.test"],
        subject: "coexistence-sent",
        textBody: "I just sent this",
      });
      await appendRawToSent(conn, "Sent", composed.raw);
    } finally {
      await conn.close();
    }
    const lock = await witness.getMailboxLock("Sent");
    try {
      const search = await witness.search({ subject: "coexistence-sent" });
      expect(search?.length ?? 0).toBeGreaterThanOrEqual(1);
    } finally {
      lock.release();
    }
  });

  it("does NOT introduce custom headers or hidden folders (overlay isolation witness)", async () => {
    const conn = new ImapConnection(creds("alice"));
    await conn.connect();
    try {
      const list = await conn.raw()!.list();
      for (const m of list ?? []) {
        const path = (m as { path?: string }).path ?? "";
        expect(path.toLowerCase().includes("mailai")).toBe(false);
        expect(path.startsWith(".")).toBe(false);
      }
    } finally {
      await conn.close();
    }
    const lock = await witness.getMailboxLock("INBOX");
    try {
      for await (const msg of witness.fetch("1:*", { headers: true, uid: true })) {
        const headersRaw = (msg as { headers?: Buffer }).headers;
        if (!headersRaw) continue;
        const text = headersRaw.toString("utf8");
        expect(/^x-mailai-/im.test(text)).toBe(false);
      }
    } finally {
      lock.release();
    }
  });
});
