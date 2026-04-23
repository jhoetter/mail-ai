# Command catalog (Phase 4 spec)

The authoritative list of commands the agent SDK exposes. Each entry
maps to a zod schema in `packages/agent/src/schemas.ts` and a
handler in one of the domain plugins. New commands MUST be added to
both this file and the staging-policy table.

| Type                     | Owner plugin      | Payload (essentials)                                                                               | Default staging   | Notes                                                                                                                |
| ------------------------ | ----------------- | -------------------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `thread:set-status`      | collaboration     | `threadId`, `status` ∈ FSM                                                                         | apply             | Status FSM enforced by handler.                                                                                      |
| `thread:assign`          | collaboration     | `threadId`, `assigneeId`                                                                           | apply             |                                                                                                                      |
| `thread:unassign`        | collaboration     | `threadId`                                                                                         | apply             |                                                                                                                      |
| `comment:add`            | collaboration     | `threadId`, `text`, `mentions?`                                                                    | apply             | `@mentions` extracted server-side.                                                                                   |
| `tag:add-to-thread`      | collaboration     | `threadId`, `tagId`                                                                                | apply             |                                                                                                                      |
| `tag:remove-from-thread` | collaboration     | `threadId`, `tagId`                                                                                | apply             |                                                                                                                      |
| `mail:mark-read`         | overlay           | `accountId`, `mailboxPath`, `uid`                                                                  | apply             | Emits `set-flag \\Seen` IMAP side-effect.                                                                            |
| `mail:mark-unread`       | overlay           | `accountId`, `mailboxPath`, `uid`                                                                  | apply             | Inverse of mark-read.                                                                                                |
| `mail:move`              | overlay (planned) | `accountId`, `from`, `to`, `uid`                                                                   | apply             | Emits `move` IMAP side-effect.                                                                                       |
| `mail:send`              | smtp-send         | `accountId`, MIME envelope + body                                                                  | **stage** (agent) | Outbound mail by an agent always stages.                                                                             |
| `mail:reply`             | smtp-send         | `threadId`, body                                                                                   | **stage** (agent) |                                                                                                                      |
| `account:connect`        | server (admin)    | `provider`, `address`                                                                              | apply             | Triggers OAuth in CLI; HTTP-only otherwise.                                                                          |
| `account:disconnect`     | server (admin)    | `accountId`                                                                                        | apply             |                                                                                                                      |
| `calendar:create-event`  | calendar          | `calendarId`, `summary`, `startsAt`, `endsAt`, `attendees?`, `meeting?` ∈ {`gmeet`,`teams`,`none`} | apply             | `meeting:'gmeet'` requires google-mail account, `'teams'` requires outlook. Sends RFC 5546 REQUEST `.ics` over SMTP. |
| `calendar:update-event`  | calendar          | `eventId`, partial event fields                                                                    | apply             | Bumps SEQUENCE; re-sends REQUEST.                                                                                    |
| `calendar:delete-event`  | calendar          | `eventId`                                                                                          | apply             | Sends CANCEL `.ics` first, then DELETEs upstream.                                                                    |
| `calendar:respond`       | calendar          | `eventId` or `icalUid`, `response`                                                                 | apply             | RSVPs upstream and emits an iTIP REPLY to organizer.                                                                 |

## Schema location

All payload schemas live in `packages/agent/src/schemas.ts`,
exported as a discriminated union `CommandPayloadSchema`. The agent
SDK and the HTTP server both import this same module — a Phase-4
build-time invariant enforced by `check-architecture.mjs` (no copies
of the schemas allowed).

## Adding a new command

1. Add the zod schema variant to `CommandPayloadSchema`.
2. Register a handler in the owning plugin.
3. Add a row to this table and to
   `spec/shared/command-bus.md#staging-policy` if the default
   policy differs.
4. Add a snapshot test in `tests/integration` so the JSON output of
   `mail-agent <subcommand> --json` is captured.
