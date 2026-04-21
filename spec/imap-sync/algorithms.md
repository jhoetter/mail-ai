# imap-sync — algorithms

Each algorithm here is implemented in `packages/imap-sync/src/` (Phase 1 build) and verified in `tests/integration/imap-coexistence.test.ts` (Phase 1 validate).

## 1. Initial sync (cold mailbox)

```
SELECT mailbox
record uid_validity, highest_mod_seq, exists
if exists == 0 → done

For each window of WINDOW=200 UIDs from highest down to lowest:
  FETCH window UID FETCH (UID FLAGS INTERNALDATE
                          BODY.PEEK[HEADER.FIELDS (...)] BODYSTRUCTURE)
  emit MessageHeader[] for each item
  yield to event loop after each window
```

Choices:

- **Most recent first** — UI usefulness > chronology purity.
- **`BODY.PEEK[HEADER.FIELDS (...)]`** — never sets `\\Seen`. Critical for IMAP coexistence.
- **Window of 200** — empirically a Gmail-friendly chunk; smaller for residential IMAP.

## 2. UIDVALIDITY change detection

Per RFC 4549 §4.3, the moment the SELECT response's UIDVALIDITY differs from our stored value, every UID we have is invalid. Our response:

```
MailboxRecord.uid_validity != server.uidValidity
  → mark all overlay messages for this mailbox as 'orphan'
  → run full initial sync as above
  → re-link orphan rows by Message-ID where possible (preserves comments/tags)
  → drop unmatched orphans after a 7-day grace
```

The Phase-2-Validate test asserts: across a UIDVALIDITY change, comments and tags survive when the underlying RFC 5322 Message-ID is unchanged.

## 3. CONDSTORE delta sync

```
SELECT mailbox (CONDSTORE)  → server reports HIGHESTMODSEQ
if HIGHESTMODSEQ == stored highest_mod_seq → no changes (use VANISHED if QRESYNC)

UID FETCH 1:* (UID FLAGS) (CHANGEDSINCE storedHighestModSeq)
  → emit flagChanges[]

UID SEARCH MODSEQ storedHighestModSeq
  → discover new UIDs (those above our stored max)
  → FETCH headers for new UIDs as in algorithm 1

If server lacks CONDSTORE: fall back to comparing stored vs server EXISTS;
  full UID SEARCH ALL when EXISTS shrunk (vanished detection).

store new HIGHESTMODSEQ
```

## 4. Vanished UID detection (no QRESYNC)

```
local_uid_set = SELECT uid FROM messages WHERE mailbox_id=?
server_uid_set = UID SEARCH ALL  (returned as ranges)

vanished = local_uid_set - server_uid_set
emit vanishedUids
```

When QRESYNC is available, we use `SELECT … (QRESYNC (uidvalidity highestModSeq))` and parse the `VANISHED` response directly — O(changes) rather than O(mailbox).

## 5. IDLE long-poll

```
loop:
  IDLE
  on EXISTS / EXPUNGE / FETCH untagged → trigger delta sync (algorithm 3)
  every 28 min (Gmail) or 29 min (MS) or 25 min (default): DONE + IDLE
  on connection lost: exponential reconnect; resume IDLE
```

We never block on IDLE waiting for a single message — every notification triggers the same delta routine, which is idempotent.

## 6. Send via SMTP + IMAP APPEND-to-Sent

Sending is logically two steps:

```
SMTP submission via smtp-send → server returns Message-ID
APPEND raw bytes to "Sent" folder via imap-sync (preserves identical RFC 822
  including DKIM signature added by server? — see note below)
```

Note: many providers add headers (DKIM, Received) at submission. To get the actual sent bytes into Sent, we either:

- (Gmail / MS) **rely on provider auto-Sent**: most major providers automatically file SMTP-submitted mail into "Sent". We detect this by looking for the message in Sent within 30 s after submit; if found, skip APPEND.
- Otherwise, **APPEND the as-submitted bytes** with the server-returned Message-ID. Acceptable trade-off (DKIM headers won't be present in our copy, but the recipient sees them on the wire).

## 7. STORE / MOVE / EXPUNGE round-trip

When a handler emits `imapSideEffects`, the outboxer:

```
for each side-effect in order:
  if STORE: UID STORE uid +FLAGS / -FLAGS (set / clear)
  if MOVE: UID MOVE uid newMailbox  (fallback: UID COPY + UID STORE +FLAGS \\Deleted + EXPUNGE)
  if EXPUNGE: UID EXPUNGE uid (fallback: STORE \\Deleted then EXPUNGE)
  if APPEND: APPEND mailbox "rawBytes"

on any failure:
  abort remaining side-effects for this command
  return error → bus rolls back overlay
```

Handlers MUST be deterministic w.r.t. their side-effects so that re-execution after a transient failure yields the same outcome.
