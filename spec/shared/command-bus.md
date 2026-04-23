# Command bus (shared)

> "Every state change is a Command; the same command vocabulary is consumed by humans and AI agents." — `prompt.md` §The AI-Native Design.

## Responsibilities

The bus owns:

1. **Validation.** zod schema check on the command payload before any handler runs. (Implemented at the agent SDK boundary so the same validator catches CLI, MCP, HTTP.)
2. **Policy.** Decide whether to apply or stage based on `policy.ts` + per-agent / per-inbox overrides.
3. **Handler dispatch.** One handler per command type. Handlers are pure logic + repo writes — they never call external services directly. (IMAP/SMTP side-effects are returned as `imapSideEffects` for an outboxer to drive.)
4. **Audit.** Every dispatched command becomes a `Mutation` row, including failures.
5. **Approval lifecycle.** `dispatch` may stage; `approve` runs the handler later; `reject` records the reason.

## Command shape

```ts
{
  type: "thread:set-status",
  payload: { threadId: "t_…", status: "resolved" },
  source: "human" | "agent" | "system",
  actorId: "u_…" | "agent:bot:slack",
  timestamp: 1745236800000,
  sessionId: "s_…",
  idempotencyKey?: "imap-uid-12345"
}
```

`idempotencyKey` is optional; when set, the bus will silently de-dup repeated dispatches with the same `(actorId, type, idempotencyKey)`. Used by `imap-sync` to avoid re-applying the same FLAGS update on reconnect.

## Mutation shape

```ts
{
  id, command,
  before: EntitySnapshot[], after: EntitySnapshot[],
  diffs: EntityDiff[],
  imapSideEffects: ImapSideEffect[],
  status: "pending" | "applied" | "failed" | "rolled-back" | "rejected",
  error?: { code, message },
  approvedBy?, approvedAt?, rejectedReason?,
  createdAt
}
```

The bus emits the mutation back to its caller and to the audit sink. The
mutation is also broadcast on the realtime channel for connected clients
to react (see [`packages/server/src/events.ts`](../../packages/server/src/events.ts)).

## Staging policy table

See [`packages/core/src/command/policy.ts`](../../packages/core/src/command/policy.ts). Summary:

| Command                                                                        | Default                       | Configurable?               |
| ------------------------------------------------------------------------------ | ----------------------------- | --------------------------- |
| `mail:mark-read`, `mail:mark-unread`                                           | auto                          | no                          |
| `thread:add-tag`, `thread:remove-tag`                                          | auto                          | no                          |
| `comment:add`                                                                  | auto                          | no                          |
| `mail:archive`, `mail:move-to-folder`, `mail:flag`                             | configurable, default approve | yes (per agent / per inbox) |
| `thread:assign`, `thread:set-status`, `thread:snooze`                          | configurable, default approve | yes                         |
| `comment:edit`, `comment:delete`                                               | configurable, default approve | yes                         |
| `account:connect`, `account:resync`                                            | configurable, default approve | yes                         |
| `mail:send`, `mail:reply`, `mail:forward`, `mail:delete`, `account:disconnect` | always approve                | no                          |

Human-source commands skip staging — humans are not staged.

## IMAP side-effect contract

A handler that mutates an entity which has an IMAP correspondence (Message, Mailbox) returns `imapSideEffects` that an "outboxer" worker translates into IMAP commands:

- `set-flag` / `unset-flag` → STORE (+/-FLAGS)
- `move` → MOVE (or COPY+EXPUNGE on legacy servers)
- `expunge` → EXPUNGE
- `append` → APPEND
- `smtp-submit` → submit via `smtp-send`, then APPEND-to-Sent

The handler itself only updates the overlay DB; the outboxer drives IMAP. This separation guarantees overlay rollback if IMAP fails (see [`agent-api.md`](agent-api.md#batch-atomicity)).
