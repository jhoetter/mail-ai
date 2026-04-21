// MailboxSyncer: initial fetch + incremental delta sync.
//
// Algorithm (matches /spec/imap-sync/algorithms.md):
//
//   1. SELECT mailbox → record UIDVALIDITY + HIGHESTMODSEQ
//   2. If stored UIDVALIDITY != server's → fullResyncRequired = true,
//      caller wipes the overlay rows for this mailbox + this account
//      and calls initialFetch()
//   3. Otherwise: SEARCH (UID > lastSyncedUid) for new, FETCH (1:* (FLAGS))
//      with CHANGEDSINCE (lastModSeq) for flag changes; rely on
//      VANISHED if QRESYNC is supported else compare UID set.
//
// The function is pure-data-out — it does NOT touch overlay-db. All
// persistence happens via command bus handlers in @mailai/overlay-db.

import { ImapConnection } from "./connection.js";
import type { DeltaChange, DeltaResult, MessageHeader, SyncState } from "./types.js";
import { MailaiError } from "@mailai/core";

export class MailboxSyncer {
  constructor(private readonly conn: ImapConnection) {}

  async initialFetch(mailboxPath: string): Promise<{
    readonly state: SyncState;
    readonly headers: readonly MessageHeader[];
  }> {
    const client = this.conn.raw();
    if (!client) throw new MailaiError("internal_error", "connection not open");
    const lock = await client.getMailboxLock(mailboxPath);
    try {
      const status = client.mailbox && typeof client.mailbox === "object" ? client.mailbox : null;
      if (!status) throw new MailaiError("imap_error", `unable to open ${mailboxPath}`);
      const headers: MessageHeader[] = [];
      // imapflow's typing for fetch is permissive; we only consume the
      // fields we care about.
      for await (const msg of client.fetch("1:*", {
        uid: true,
        flags: true,
        envelope: true,
        bodyStructure: true,
        size: true,
        internalDate: true,
      })) {
        headers.push(toHeader(msg));
      }
      const state: SyncState = {
        mailboxPath,
        uidValidity: Number(status.uidValidity ?? 0),
        highestModSeq:
          status.highestModseq != null ? BigInt(status.highestModseq.toString()) : null,
        lastSyncedUid: headers.reduce((m, h) => Math.max(m, h.uid), 0),
        lastFetchAt: Date.now(),
      };
      return { state, headers };
    } finally {
      lock.release();
    }
  }

  async deltaSync(prev: SyncState): Promise<DeltaResult> {
    const client = this.conn.raw();
    if (!client) throw new MailaiError("internal_error", "connection not open");
    const lock = await client.getMailboxLock(prev.mailboxPath);
    try {
      const status = client.mailbox && typeof client.mailbox === "object" ? client.mailbox : null;
      if (!status) throw new MailaiError("imap_error", `unable to open ${prev.mailboxPath}`);
      const uidValidity = Number(status.uidValidity ?? 0);
      if (uidValidity !== prev.uidValidity) {
        return {
          mailbox: prev.mailboxPath,
          uidValidity,
          newHighestModSeq: status.highestModseq ? BigInt(status.highestModseq.toString()) : null,
          changes: [],
          fullResyncRequired: true,
        };
      }
      const changes: DeltaChange[] = [];
      const fetchOpts: Parameters<typeof client.fetch>[1] = {
        uid: true,
        flags: true,
      };
      const range = `${prev.lastSyncedUid + 1}:*`;
      // New + flag changes since last modseq
      const sinceOpts =
        prev.highestModSeq != null ? { changedSince: prev.highestModSeq } : undefined;
      for await (const msg of client.fetch(
        "1:*",
        { ...fetchOpts, envelope: true, internalDate: true, size: true },
        sinceOpts,
      )) {
        const uid = msg.uid ?? 0;
        if (uid > prev.lastSyncedUid) {
          changes.push({ kind: "new", uid, flags: Array.from(msg.flags ?? []) });
        } else {
          changes.push({
            kind: "flags-changed",
            uid,
            flags: Array.from(msg.flags ?? []),
            ...(msg.modseq ? { modSeq: BigInt(msg.modseq.toString()) } : {}),
          });
        }
      }
      // Catch-up for any UID > lastSyncedUid that didn't appear above
      // (servers without CONDSTORE will return everything in `range`).
      if (!sinceOpts) {
        for await (const msg of client.fetch(range, fetchOpts)) {
          const uid = msg.uid ?? 0;
          if (uid > prev.lastSyncedUid) {
            changes.push({ kind: "new", uid, flags: Array.from(msg.flags ?? []) });
          }
        }
      }
      return {
        mailbox: prev.mailboxPath,
        uidValidity,
        newHighestModSeq: status.highestModseq ? BigInt(status.highestModseq.toString()) : null,
        changes,
        fullResyncRequired: false,
      };
    } finally {
      lock.release();
    }
  }
}

function toHeader(msg: {
  uid?: number;
  flags?: Set<string> | string[];
  modseq?: number | bigint | string;
  internalDate?: Date;
  size?: number;
  envelope?: {
    messageId?: string;
    subject?: string;
    date?: Date;
    from?: Array<{ name?: string; address?: string }>;
    to?: Array<{ name?: string; address?: string }>;
    inReplyTo?: string;
  };
  bodyStructure?: unknown;
}): MessageHeader {
  const env = msg.envelope ?? {};
  return {
    uid: msg.uid ?? 0,
    flags: msg.flags ? Array.from(msg.flags) : [],
    modSeq: msg.modseq != null ? BigInt(msg.modseq.toString()) : null,
    internalDate: msg.internalDate ?? new Date(0),
    size: msg.size ?? 0,
    envelope: {
      messageId: env.messageId ?? null,
      subject: env.subject ?? null,
      date: env.date ?? null,
      from: (env.from ?? []).flatMap((a) => {
        if (!a.address) return [];
        const out: { name?: string; address: string } = { address: a.address };
        if (a.name) (out as { name?: string }).name = a.name;
        return [out];
      }),
      to: (env.to ?? []).flatMap((a) => {
        if (!a.address) return [];
        const out: { name?: string; address: string } = { address: a.address };
        if (a.name) (out as { name?: string }).name = a.name;
        return [out];
      }),
      inReplyTo: env.inReplyTo ?? null,
    },
    bodyStructure: msg.bodyStructure,
  };
}
