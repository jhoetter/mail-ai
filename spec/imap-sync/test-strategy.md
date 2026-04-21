# imap-sync — test strategy

## Three layers of test

### 1. Pure unit tests (fast, no docker)

In `packages/imap-sync/test/`. They cover:

- Mailbox path normalisation (Gmail's `[Gmail]/All Mail` → logical id).
- Header projection (a fixture raw message → expected `MessageHeader`).
- UIDVALIDITY decision: given (stored, server) → expected action.
- Pool sizing under provider rate-limit responses.

These run in `pnpm --filter @mailai/imap-sync test`.

### 2. Integration tests against Greenmail (docker, in CI)

`tests/integration/imap-coexistence.test.ts`. Greenmail is JVM-based and starts in a container declared in `infra/docker/compose.dev.yml` on ports 3143/3025.

Coverage:

- **Initial sync** of a 100-message mailbox; assert all UIDs persisted.
- **Delta sync**: drop a message externally → assert vanished UID detected.
- **Flag changes**: STORE +FLAGS \\Seen via Greenmail's API → verify our delta picks it up.
- **APPEND cycle**: APPEND raw RFC 822 → assert MailboxSyncer surfaces it as a new message.
- **IMAP coexistence witness**: a separate IMAP client (raw `node-imap` connection) reads the mailbox before & after our sync, asserts identical FLAGS + INTERNALDATE + UID set. This is the proof that we are non-destructive.

### 3. Real-world tests against Dovecot (docker, opt-in)

Run via `MAILAI_RUN_DOVECOT=1 pnpm test:integration`. Dovecot supports CONDSTORE/QRESYNC properly so it's the more realistic test bed. CI runs Greenmail by default for speed; Dovecot is run nightly (or before release).

## Coexistence test in detail

```ts
test("our sync does not modify FLAGS or INTERNALDATE", async () => {
  // 1. seed mailbox with 50 messages via raw IMAP client
  const before = await rawClient.fetch("1:*", "FLAGS INTERNALDATE");

  // 2. run our syncer
  const syncer = new MailboxSyncer(...);
  await syncer.run("INBOX");

  // 3. read again with raw client
  const after = await rawClient.fetch("1:*", "FLAGS INTERNALDATE");

  expect(after).toEqual(before);
});
```

This fails if our code accidentally:

- sets `\\Seen` (via FETCH BODY[] instead of BODY.PEEK[]);
- moves a message;
- adds a flag/keyword for our own bookkeeping;
- changes INTERNALDATE via APPEND.

## Performance test

`pnpm test:integration:perf` (tagged so it doesn't run on every CI). Seeds 10 000 messages and asserts:

- Initial sync completes in ≤ 90 s on the CI runner.
- Delta sync after seeding 10 new messages completes in ≤ 5 s.
- Memory peak under 200 MB.

If thresholds are exceeded, we re-tune `WINDOW` and pool size before merging.

## OAuth tests

- Happy path: Greenmail does not support OAuth, so OAuth is tested with mocked token endpoints (vitest `msw` setup) and verified end-to-end against a local mock IMAP server (port 7143) that accepts the bearer.
- Sad path: expired token → refresh → retry succeeds.
- Sad path: refresh token revoked → account marked `needs-reauth`.
