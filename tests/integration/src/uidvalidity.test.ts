// UIDVALIDITY change determinism: when the server reports a new
// UIDVALIDITY, MailboxSyncer.deltaSync must request a full resync and
// downstream code (overlay-db) must be able to re-link historical
// messages by Message-ID — implemented in Phase 3.
//
// This test focuses on the sync layer's behaviour. The persistence
// re-linking is exercised by overlay-db tests in Phase 3.

import { describe, expect, it } from "vitest";
import { MailboxSyncer } from "@mailai/imap-sync";

describe("UIDVALIDITY change", () => {
  it("delta sync flags fullResyncRequired when UIDVALIDITY differs", async () => {
    const fakeStatus = {
      uidValidity: 99,
      highestModseq: { toString: () => "10" },
    };
    const fetchIter = (async function* () {
      // no messages — we only care about the UIDVALIDITY-change branch
    })();
    const fakeClient = {
      mailbox: fakeStatus,
      getMailboxLock: async () => ({ release: () => undefined }),
      fetch: () => fetchIter,
    };
    const conn = { raw: () => fakeClient } as unknown as ConstructorParameters<
      typeof MailboxSyncer
    >[0];
    const syncer = new MailboxSyncer(conn);
    const result = await syncer.deltaSync({
      mailboxPath: "INBOX",
      uidValidity: 1, // different from server (99)
      highestModSeq: 10n,
      lastSyncedUid: 100,
      lastFetchAt: 0,
    });
    expect(result.fullResyncRequired).toBe(true);
    expect(result.uidValidity).toBe(99);
  });
});
