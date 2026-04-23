# Phase 1 Analyze — IMAP sync prior art

Clean-room study of every public reference; we read code, take notes, then **implement from scratch** per the legal constraint in `prompt.md`.

## Reference repos

- **Mail-0/Zero** — modern TS, prioritises Gmail's labels-as-folders. Uses `imapflow` for IMAP. Their pool is single-connection-per-user; we expand to provider-aware multi-connection (Gmail caps 15, Microsoft 20).
- **UnInbox** — Postgres+Drizzle, queue-driven sync. Key takeaway: their `bullmq` worker per mailbox is the right granularity. We adopt it.
- **inbox-zero** — Next.js shell with simple Gmail API integration; we ignore the API path and use IMAP universally per prompt.md scope.
- **nylas-mail** — Electron-era. Reference for UIDVALIDITY change handling (our [`algorithms.md`](algorithms.md) #2) and for the "sync-window" trick (most-recent-first).

## Protocol primary sources

- RFC 3501 — IMAP4rev1 baseline (LIST, SELECT, FETCH, STORE, APPEND, EXPUNGE, IDLE).
- RFC 4549 — Synchronization Operations for Disconnected IMAP4 Clients. Defines UIDVALIDITY semantics; our `MailboxSyncer` follows §4.3 (full resync on change).
- RFC 4551 — IMAP CONDSTORE (HIGHESTMODSEQ + CHANGEDSINCE FETCH/SEARCH).
- RFC 5162 — IMAP QRESYNC (vanished UIDs); used when supported, otherwise we diff UID sets manually.
- RFC 2177 — IMAP IDLE.
- RFC 4978 — IMAP COMPRESS (we negotiate but do not require).
- RFC 5322 + 6532 — message format (Internationalised headers).
- RFC 6750 — Bearer tokens for SMTP submission with XOAUTH2 / OAUTHBEARER.

## Library decision: `imapflow`

- Picked over `node-imap` because it surfaces an async iterator for FETCH (no callback-buffer juggling for 10k-message mailboxes), exposes per-mailbox `lock` to prevent overlapping SELECTs, and ships with QRESYNC + CONDSTORE auto-detection.
- Constraints noted: `imapflow` does not abstract Gmail label semantics — we add a thin adapter in [`packages/imap-sync/src/syncer.ts`](../../packages/imap-sync/src/syncer.ts) (Phase 1 build) that maps Gmail's `\\All Mail` to a logical "all" view when listing.

## Provider rate-limit table (extracted from public docs)

| Provider                | Concurrent IMAP per user | IDLE max                 | Notes                                              |
| ----------------------- | ------------------------ | ------------------------ | -------------------------------------------------- |
| Gmail                   | 15                       | session 28 m → reconnect | OAuth scope `https://mail.google.com/`.            |
| Outlook / Microsoft 365 | 20                       | session 29 m             | XOAUTH2 + tenant consent variants.                 |
| Other IMAP              | configurable, default 5  | varies                   | We probe `IDLE` capability; fall back to 30s NOOP. |

## Open questions answered before Build

- **Q**: Do we need QRESYNC, or is plain CONDSTORE enough?  
  **A**: CONDSTORE-only suffices for v1 (we already track every UID locally). QRESYNC is a Phase-2 perf upgrade.
- **Q**: How do we handle Gmail "All Mail" + Inbox label duplication?  
  **A**: Treat each mailbox path independently for sync; dedup at the **overlay layer** by `Message-ID` (Phase-2 build, [`overlay/spec/algorithms.md`](../overlay/algorithms.md#dedup-by-message-id)). Sync layer does NOT try to be label-aware.
- **Q**: Microsoft tenant consent — do we need admin consent for IMAP scope?  
  **A**: Yes for tenant-wide; for personal MS accounts user consent suffices. Documented in [`security-model.md`](../shared/security-model.md#oauth--microsoft-tenants).
