# RBAC

Two layers:

1. **Tenant role** (`users.role`): `admin`, `member`, `read-only`. Set at user creation; rare to change.
2. **Inbox role** (`inbox_members.role`): `inbox-admin`, `agent`, `viewer`.

A command is allowed if BOTH layers grant the permission required by the command.

## Permission matrix (excerpt)

| Command                                   | Tenant minimum | Inbox role    |
| ----------------------------------------- | -------------- | ------------- |
| `mail:mark-read`, `mail:mark-unread`      | `read-only`    | `viewer`      |
| `comment:add`                             | `member`       | `agent`       |
| `thread:assign`, `thread:set-status`      | `member`       | `agent`       |
| `mail:send`, `mail:reply`, `mail:forward` | `member`       | `agent`       |
| `mail:delete`                             | `member`       | `inbox-admin` |
| `account:connect`, `account:disconnect`   | `admin`        | n/a           |
| `inbox:create`, `inbox:add-member`        | `admin`        | n/a           |

## Implementation

`packages/collaboration/src/rbac.ts` exports `checkPermission(user, inbox?, command): "allow" | { deny: reason }`. The RBAC check happens in `packages/server` route handlers BEFORE `bus.dispatch`, so the audit log records the actor's identity but not denied attempts. Denied attempts are logged separately to `audit_log` with `status='denied'` so admins can investigate.

## Service / agent identity

Agents have `actorId` like `agent:slack-bot:t_acme`. The bus treats them as `source: "agent"`; the underlying authentication identifies which user-equivalent role they have (admin / member). Per-agent overrides go through `PolicyOverrides.perAgent`.

## Out of scope for v1

- Per-thread ACLs.
- Per-tag visibility.
- Customer-of-record visibility (e.g. CRM-driven thread filtering).

These can be layered on top by adding pre-dispatch middleware later.
