# Thread status FSM

```
        snooze(until)
   ┌───────────────────►┌──────────┐
   │                    │ snoozed  │
┌──┴────┐  resolve      │          │
│ open  ├──────────────►├──────────┤
│       │◄──────────────┤resolved  │
└───┬───┘   reopen      └──────────┘
    │ ▲                       ▲
    │ │ snooze-elapsed        │
    │ └───────────────────────┘
    │
    │ resolve
    ▼
 (resolved)
```

## State table

| Current | Command | Allowed → next |
| --- | --- | --- |
| `open` | `thread:set-status snoozed` (with `snoozed_until`) | `snoozed` |
| `open` | `thread:set-status resolved` | `resolved` |
| `snoozed` | `thread:set-status open` | `open` |
| `snoozed` | `thread:set-status resolved` | `resolved` |
| `resolved` | `thread:set-status open` | `open` |
| `*` | `thread:snooze-elapsed` (system) | `open` (only valid if currently `snoozed`) |
| `*` | any other status command | `MailaiError("conflict_error")` |

## Implementation

- Validation lives in `packages/collaboration/src/status.ts` as a pure function `nextStatus(current, command, payload): { next: ThreadStatus; sideEffects: [] }`.
- The plugin handler calls `nextStatus`, then `threads.setStatus`. Failure throws and the bus records the mutation as `failed`.
- A scheduled worker (`packages/collaboration/src/sla.ts`) runs every minute, queries `threads WHERE status='snoozed' AND snoozed_until <= now()`, and dispatches `thread:set-status open` with `source: "system"`.

## Why no "in-progress" state?

We considered `in-progress` as an extra state between `open` and `resolved`. It adds friction without measurable value: assignment + status `open` already conveys "someone is working on this". Open to revisit per-tenant.
