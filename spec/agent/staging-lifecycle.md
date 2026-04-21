# Staged-mutation lifecycle (Phase 4 spec)

Agent-proposed mutations may need human approval. The lifecycle
below is the single source of truth for how a staged mutation moves
through the system.

## States

```
created (agent dispatch + policy says "stage")
  ↓ approve(by=user)
applied
  ↓ rejected(reason)
rejected
```

The `Mutation.status` enum has exactly these states; there is no
"in-review" state — a mutation is either `pending`, `applied`,
`rejected`, `failed`, or (after IMAP rollback) `rolled-back`.

## Decision boundary

A command is staged when **all** of the following hold:

1. `Command.source === "agent"`.
2. The default policy for `Command.type` says `stage`, **or** the
   tenant has set an override (per-inbox or per-tenant) that
   forces staging.

Humans never have their commands staged unless the tenant explicitly
opts a command type into "review" mode (e.g., for compliance).

## Approval

`bus.approve(mutationId, approvedBy)` is the only path that
transitions `pending → applied`:

1. Reload the mutation, re-resolve the handler, **re-execute** with
   current state. (We deliberately do NOT replay the agent's
   originally-computed `after` snapshot — the world may have moved
   on between staging and approval, so we re-evaluate validation
   and side-effects fresh.)
2. Persist `approvedBy`/`approvedAt` alongside the new `before`/
   `after`/`diffs`.
3. Fan out an audit row + a `mutation:applied` WebSocket event.

Failure during re-execution leaves the mutation in `failed` (not
`rejected`) so the operator can distinguish "human said no" from
"the world changed and now it's invalid".

## Rejection

`bus.reject(mutationId, reason?)` is fire-and-forget: status flips
to `rejected`, `rejectedReason` is recorded, no handler runs. Audit
sink still fires — rejection IS an auditable event.

## Visibility

`getPendingMutations({actorId, type})` returns the current pending
queue scoped to the calling tenant (RLS) and optionally filtered by
actor / type. The CLI uses this for `mail-agent pending list`.

## Per-inbox overrides

`PolicyOverrides` accepts `(inboxId, type) → "apply" | "stage"`
entries; the bus consults it before falling back to the default
table. This is how a single inbox can demand "all `mail:reply`s
require approval, even from humans" without affecting the rest of
the tenant.
