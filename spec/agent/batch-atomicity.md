# Batch atomicity semantics (Phase 4 spec)

`MailAgent.applyCommands(inputs)` is the bulk entry point. It is
**not transactional** in the database sense — IMAP cannot
participate in a Postgres transaction — so the contract is
explicit and narrow.

## Per-command guarantees

1. Each command's overlay write runs in its own DB transaction
   (`withTenant(...)` wraps the whole handler).
2. Each command's IMAP side-effects run _after_ the overlay
   transaction commits, via the outboxer.
3. If the IMAP side-effect fails _after_ the overlay commit:
   - The mutation is moved to `rolled-back`.
   - A compensating overlay change is enqueued (e.g., a flag flip).
   - The audit log records BOTH the original `applied` and the
     subsequent `rolled-back` rows.

## Batch-level guarantees

`applyCommands([a, b, c])` returns:

```ts
interface BatchResult {
  results: Array<{
    status: "applied" | "rejected" | "failed" | "pending" | "rolled-back";
    mutation: Mutation;
  }>;
  appliedCount: number;
  failedAt?: number; // index of first failure, if any
  abortedRest: boolean; // true if `stopOnError` was set and we stopped
}
```

The `stopOnError` option (default `true`) controls whether a failure
short-circuits the rest of the batch. Either way, every entered
command produces an entry in `results` (failed-and-skipped commands
get `status: "failed"` with `error.code = "skipped"`).

## What's intentionally NOT guaranteed

- **No global rollback.** If `b` fails after `a` succeeded, `a` stays
  applied. The agent must compensate via a follow-up command if
  desired.
- **No reordering.** Commands run in input order. Concurrency is the
  caller's job; the bus serializes within a single `applyCommands`
  call.
- **No partial-staging atomicity.** If half the batch is auto-staged
  and half auto-applies, there is no way to "approve the batch as
  one" — the operator approves each pending mutation
  individually. (This is intentional: we don't want a single
  approve click to apply work the operator hasn't seen.)

## Why this design

IMAP has no transactions. Pretending it does in the SDK would either
require an unbounded compensating-action engine or a fragile
two-phase commit. We pick the simpler model: per-command
durability, explicit audit of rollbacks, and batch reporting.
