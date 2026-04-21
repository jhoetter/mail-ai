// Compute vanished UIDs by diffing the local UID set against the server's.
// QRESYNC servers report VANISHED responses directly; for everything else
// we issue UID SEARCH ALL and diff the result against our stored set. The
// caller passes a flat number[] from the overlay-db (mailbox_id → uids).

import type { ImapConnection } from "./connection.js";
import { MailaiError } from "@mailai/core";

export async function computeVanishedUids(
  conn: ImapConnection,
  mailboxPath: string,
  knownUids: readonly number[],
): Promise<number[]> {
  const client = conn.raw();
  if (!client) throw new MailaiError("internal_error", "connection not open");
  const lock = await client.getMailboxLock(mailboxPath);
  try {
    const serverUids = (await client.search({ all: true }, { uid: true })) ?? [];
    const serverSet = new Set<number>(serverUids.map(Number));
    const vanished: number[] = [];
    for (const uid of knownUids) {
      if (!serverSet.has(uid)) vanished.push(uid);
    }
    return vanished;
  } finally {
    lock.release();
  }
}
