# Web UI scope (Phase 5 spec)

The Next.js app at `apps/web` is the reference UI for mail-ai. It
is **the** UI for the standalone product and the source for the
embeddable bundle (`@mailai/react-app`). Anything users can do in
the web UI must be expressible as commands on the bus — no
"settings page only" mutations.

## In-scope screens

| Route                          | Purpose                                                     |
| ------------------------------ | ----------------------------------------------------------- |
| `/login`                       | OAuth-redirect login                                        |
| `/inbox`                       | Default inbox view, three-pane layout (folders/threads/preview) |
| `/inbox/[inboxId]`             | Inbox switcher                                              |
| `/inbox/[inboxId]/thread/[id]` | Thread reading + replying + commenting                      |
| `/compose`                     | Standalone compose window (split from inbox view)           |
| `/search?q=...`                | Full-text + filter search (FTS-backed)                      |
| `/settings/account`            | Connect/disconnect IMAP+OAuth accounts                      |
| `/settings/inboxes`            | Shared inbox config + members                               |
| `/settings/agents`             | API tokens, agent staging policies                          |
| `/settings/audit`              | Read-only audit log viewer                                  |
| `/pending`                     | Approval queue for staged agent mutations                   |

## Out of scope (v1)

- Calendar / contacts management.
- Custom email templates beyond plain reply quoting.
- Drag-and-drop folder reorganization (we treat IMAP folders as
  authoritative, not as a UI artifact to redesign).
- Native push (web push, mobile push).

## Layout principles

- **Three panes minimum** (folders | threads | preview) on ≥ md
  screens; collapses to a stack on small.
- **Keyboard-first**: every primary action has a shortcut; mouse
  is the slow path. See `keyboard.md`.
- **No modals for destructive actions** without a "Cmd+Z to
  undo" undo bar. We optimize for fast triage.
- **Real-time**: every list is live via `WebSocket` events from
  `apps/realtime-server`. No manual refresh button.

## Data flow

- All mutations route through the in-process `MailAgent` (which
  calls `CommandBus` directly) — never through `fetch` calls
  that bypass the bus. Server actions in Next call the same SDK.
- Reads use the overlay-db repositories with the user's
  tenant context applied via `withTenant`.
- The Next server is the single tenant-context boundary; client
  components receive serializable view models, never raw
  repository handles.

## Why a separate Next app

The Next frontend exists to ship a **product**. The
`@mailai/react-app` package re-exports the same React tree (minus
the Next-specific bits) so a third-party host (e.g., hof-os) can
embed mail-ai without spawning a Next process. This split keeps
the product story honest: the UI proves the SDK is enough.
