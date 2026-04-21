// Performance acceptance: initial sync of a 10k-message mailbox.
//
// Tagged with MAILAI_PERF=1 so it does not run on every CI; the regular
// suite stays fast. Runs against Greenmail or Dovecot — set HOST/PORT
// the same way other integration tests do.

import { describe, it, expect } from "vitest";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import {
  ImapConnection,
  MailboxSyncer,
  type AccountCredentials,
} from "@mailai/imap-sync";

const ENABLED = process.env["MAILAI_PERF"] === "1";
const HOST = process.env["MAILAI_IMAP_HOST"] ?? "127.0.0.1";
const IMAP_PORT = Number(process.env["MAILAI_IMAP_PORT"] ?? 3143);
const SMTP_PORT = Number(process.env["MAILAI_SMTP_PORT"] ?? 3025);
const N = Number(process.env["MAILAI_PERF_N"] ?? 10_000);
const TARGET_INITIAL_MS = Number(process.env["MAILAI_PERF_INITIAL_MS"] ?? 90_000);
const TARGET_DELTA_MS = Number(process.env["MAILAI_PERF_DELTA_MS"] ?? 5_000);

const describeIf = ENABLED ? describe : describe.skip;

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

async function seed(n: number): Promise<void> {
  const transporter = nodemailer.createTransport({ host: HOST, port: SMTP_PORT, secure: false });
  for (let i = 0; i < n; i++) {
    await transporter.sendMail({
      from: "seeder@mailai.test",
      to: "alice@mailai.test",
      subject: `perf-${i}`,
      text: `body ${i}`,
    });
  }
}

describeIf("perf: 10k messages", () => {
  it(`initial sync ≤ ${TARGET_INITIAL_MS}ms; delta ≤ ${TARGET_DELTA_MS}ms`, async () => {
    await seed(N);
    const conn = new ImapConnection(creds("alice"));
    await conn.connect();
    try {
      const t0 = Date.now();
      const syncer = new MailboxSyncer(conn);
      const initial = await syncer.initialFetch("INBOX");
      const initialMs = Date.now() - t0;
      expect(initial.headers.length).toBeGreaterThanOrEqual(N);
      expect(initialMs).toBeLessThan(TARGET_INITIAL_MS);

      // Seed 10 more for delta
      const transporter = nodemailer.createTransport({ host: HOST, port: SMTP_PORT, secure: false });
      for (let i = 0; i < 10; i++) {
        await transporter.sendMail({
          from: "seeder@mailai.test",
          to: "alice@mailai.test",
          subject: `perf-delta-${i}`,
          text: "delta",
        });
      }
      const t1 = Date.now();
      const delta = await syncer.deltaSync(initial.state);
      const deltaMs = Date.now() - t1;
      expect(delta.changes.filter((c) => c.kind === "new").length).toBeGreaterThanOrEqual(10);
      expect(deltaMs).toBeLessThan(TARGET_DELTA_MS);
    } finally {
      await conn.close();
    }
    // ensure ImapFlow type import is not tree-shaken from compile
    expect(typeof ImapFlow).toBe("function");
  });
});
