# Architecture (shared)

## Layers

```
                ┌────────────────────────┐
                │ apps/web   (Next.js)   │  ← human UI
                │ apps/realtime-server   │
                └──────────┬─────────────┘
                           │ HTTPS + WS
                ┌──────────▼─────────────┐
                │ packages/server        │  ← only network surface
                │  fastify + ws          │
                └──────────┬─────────────┘
                           │ in-process
                ┌──────────▼─────────────┐
                │ packages/agent         │  ← MailAgent SDK (in-proc + HTTP)
                │  zod-validated facade  │
                └──────────┬─────────────┘
                           │
                ┌──────────▼─────────────┐
                │ packages/core          │  ← CommandBus  (THE seam)
                └─┬──────┬───────┬───────┘
                  │      │       │
       ┌──────────▼┐  ┌──▼─────┐ │ ┌──────────────┐
       │ collab    │  │ imap-  │ │ │ overlay-db   │  drizzle + pg
       │ plugin    │  │ sync   │ │ │ repositories │
       └───────────┘  └────────┘ │ └──────────────┘
                                 │
                          ┌──────▼─────┐
                          │ smtp-send  │
                          └────────────┘
```

## Architectural rules (CI-enforced)

These come straight from prompt.md §Architecture Principles and are checked by [`scripts/check-architecture.mjs`](../../scripts/check-architecture.mjs):

1. **Headless-first.** No package below `apps/` may import React, Next, or any DOM-only API.
2. **Commands are the only mutation path.** All persistent writes route through `CommandBus.dispatch`. Repositories may be read directly; writes inside repositories are only callable from registered handlers.
3. **Single ownership of side-effects.**
   - `imapflow` may only be imported from `packages/imap-sync`.
   - `nodemailer` may only be imported from `packages/smtp-send`.
   - `pg` / `drizzle-orm/node-postgres` may only be imported from `packages/overlay-db`.
   - `fastify` and `ws` may only be imported from `packages/server` (and `apps/realtime-server` for `ws`).
4. **No overlay smuggling.** No code path may set IMAP headers/folders for our own metadata. Phase 1 Validate enforces this with an isolation-snapshot test.

## Boundaries between packages

| Package         | Inputs                             | Outputs                               | Forbidden                               |
| --------------- | ---------------------------------- | ------------------------------------- | --------------------------------------- |
| `core`          | command + handlers                 | mutations                             | DOM, IMAP, SQL                          |
| `mime`          | bytes                              | typed `ParsedMessage`, composed `raw` | sockets                                 |
| `imap-sync`     | `AccountCredentials`, mailbox path | `MessageHeader[]`, `DeltaResult`      | DB writes                               |
| `overlay-db`    | mutations + queries                | rows, audit                           | sockets                                 |
| `smtp-send`     | composed message + credentials     | `SendOutcome`                         | DB writes, IMAP APPEND (delegated back) |
| `collaboration` | command, repos                     | new snapshots                         | sockets, IMAP                           |
| `agent`         | typed CLI/MCP/HTTP input           | `Mutation` results                    | sockets (transport injected)            |
| `server`        | HTTP / WS                          | bus dispatch + broadcast              | domain logic                            |

## Dependency direction

```
apps/web ──▶ ui, design-tokens
apps/realtime-server ──▶ (alone)
server ──▶ agent, core, overlay-db, collaboration
agent ──▶ core, overlay-db
collaboration ──▶ core, overlay-db
imap-sync ──▶ core, mime
overlay-db ──▶ core, mime
mime ──▶ core
core ──▶ (no internal deps)
```

There are **no cycles**. Each arrow corresponds to an explicit package.json dependency.
