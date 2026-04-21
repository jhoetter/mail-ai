# Plugin system (shared)

A "plugin" is an object that registers command handlers + reactor hooks against a `CommandBus`. Plugins are how each domain layer (collaboration, agent, sync) is wired up; they are NOT a runtime extension mechanism for third parties (that's a Phase-6 stretch goal).

```ts
interface MailaiPlugin {
  name: string;
  description?: string;
  register(bus: CommandBus): void | Promise<void>;
}
```

## Design choices

- Plugins are **statically known at server boot**. We do not load arbitrary code from the database; that would defeat the audit log and RBAC.
- Plugin order matters for **handler precedence**: the first plugin to register a given command type wins; subsequent registrations throw. Registration happens at boot, so this is immediately discovered.
- Plugins MUST NOT register handlers for command types they don't own. The collaboration plugin owns `thread:*` and `comment:*`; the imap-sync plugin owns `imap:fetch` etc. Cross-plugin handler registration is a code review issue, not a runtime issue.

## Built-in plugins (v1)

| Plugin | Owns |
| --- | --- |
| `imap-sync` | `imap:fetch`, `imap:sync-mailbox`, `imap:apply-side-effects` |
| `collaboration` | `thread:set-status`, `thread:assign`, `thread:unassign`, `comment:add`, `tag:*` |
| `agent-policy` | (no handlers) — registers an audit observer that emits webhook events for each mutation |
| `outboxer` | `imap:apply-side-effects` consumer; relays handler output to IMAP/SMTP |

## Future hook points (designed-in, not built)

- `beforeDispatch(cmd)` — middleware to add tracing / rate limits.
- `afterMutation(mutation)` — observer for analytics.
- Both can be added without breaking existing plugins because the bus exposes a `use(middleware)` extension point (sketched in `packages/core/src/command/bus.ts` for v2).
