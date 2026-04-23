# @mailai/imap-sync

The only package that imports `imapflow`. See:

- [`spec/imap-sync/architecture.md`](../../spec/imap-sync/architecture.md)
- [`spec/imap-sync/algorithms.md`](../../spec/imap-sync/algorithms.md)
- [`spec/imap-sync/edge-cases.md`](../../spec/imap-sync/edge-cases.md)
- [`spec/imap-sync/test-strategy.md`](../../spec/imap-sync/test-strategy.md)

## Quick map

| File                                    | Purpose                                                     |
| --------------------------------------- | ----------------------------------------------------------- |
| `types.ts`                              | Public types — `MessageHeader`, `DeltaResult`, `SyncState`. |
| `connection.ts`                         | `ImapConnection` lifecycle wrapper around `ImapFlow`.       |
| `pool.ts`                               | Per-account pool, provider rate limits.                     |
| `syncer.ts`                             | `MailboxSyncer` — initial + delta sync.                     |
| `idle.ts`                               | `IdleListener` with NOOP fallback.                          |
| `vanished.ts`                           | UID set diff for non-QRESYNC servers.                       |
| `outboxer.ts`                           | Drives STORE/MOVE/EXPUNGE/APPEND from `ImapSideEffect[]`.   |
| `worker.ts`                             | BullMQ wiring: `sync-account`, `apply-side-effects` jobs.   |
| `oauth/google.ts`, `oauth/microsoft.ts` | XOAUTH2 token issuance + refresh.                           |

## What this package will NOT do

- Persist anything (overlay-db's job).
- Decide collaboration semantics (collaboration plugin's job).
- Hold a CommandBus reference. The bus is constructed elsewhere; this
  package is a pure side-effect adapter consumed via plugin handlers.
