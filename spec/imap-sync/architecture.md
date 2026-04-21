# imap-sync architecture

The `@mailai/imap-sync` package owns **all** IMAP socket activity in mail-ai. It exposes typed primitives upstream; downstream packages never see `imapflow` types.

## Modules

```
packages/imap-sync/src/
├── types.ts           ← AccountCredentials, Mailbox, MessageHeader, DeltaResult
├── connection.ts      ← thin wrapper around imapflow ImapFlow
├── pool.ts            ← per-account pool with per-mailbox locks
├── syncer.ts          ← MailboxSyncer (initial + delta + UIDVALIDITY handling)
├── idle.ts            ← IdleListener (long-poll IDLE with reconnect)
├── outboxer.ts        ← consumes ImapSideEffect[] → STORE/MOVE/EXPUNGE/APPEND
└── oauth/
    ├── google.ts
    └── microsoft.ts
```

## Connection lifecycle

1. `Pool.acquire(accountId)` → returns a `Connection`. The pool keeps `min=1, max=providerCap` connections per account.
2. `Connection.lockMailbox(path)` → `await using lock = …` (TS 5.2 explicit resource management). Internal `imapflow` lock prevents overlapping SELECTs on the same socket.
3. On IDLE: a separate, dedicated connection per account holds INBOX (and other watched folders, as separate connections subject to provider cap). IDLE is forcibly recycled every 28 minutes (Gmail) / 29 minutes (Microsoft) to avoid silent server-side disconnect.
4. Connection close on idle pool timeout (60s of zero in-flight ops).

## Sync flow

```
                      ┌──────────────┐
                      │ Account row  │
                      └──────┬───────┘
                             │ enqueue "sync-account"
                             ▼
       ┌──────────────────────────────────────────┐
       │ Worker(account):                         │
       │   for each mailbox in LIST:              │
       │     MailboxSyncer.run(mailbox)           │
       │   start IdleListener(INBOX, …)           │
       └──────────────────────────────────────────┘
                             │
                             ▼ per mailbox
            ┌──────────────────────────────────┐
            │  if mailbox.uid_validity changed │
            │    → full resync                 │
            │  else                            │
            │    → CONDSTORE delta             │
            │       (CHANGEDSINCE highestModSeq)│
            └──────────────────────────────────┘
```

## Output format

`MailboxSyncer.run()` returns a `DeltaResult`:

```ts
{
  newMessages: MessageHeader[],
  flagChanges: { uid: number, flags: string[] }[],
  vanishedUids: number[],
  newHighestModSeq: bigint,
  uidValidityChanged: boolean
}
```

Downstream (overlay-db, threading) operates entirely on `MessageHeader` — there's no leaked `imapflow` symbol upstream.

## Failure handling

- **Network drop** → automatic exponential reconnect with jitter (250 ms → 30 s cap).
- **Auth failure** → mark account `needs-reauth`, stop the worker, surface a `Notification` mutation.
- **Provider rate limit (Gmail "Too many simultaneous connections")** → reduce pool size by 1, retry after 60 s.
- **Mailbox SELECT failure (ENOENT-equivalent)** → mark mailbox `gone`, do not delete overlay rows (user might rename back).
