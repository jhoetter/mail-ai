# MCP stdio server (Phase 4 spec)

`mail-agent mcp` runs the [Model Context Protocol] stdio server,
exposing the same command catalog as the CLI to LLM-based clients
(Cursor, Claude Desktop, custom agent harnesses).

[Model Context Protocol]: https://modelcontextprotocol.io/

## Tool surface

Each command in `command-catalog.md` maps to one MCP tool. Tool
names are namespaced: `mail.thread.assign`, `mail.thread.setStatus`,
`mail.comment.add`, `mail.send`, etc. Tool input schemas are
generated from the same zod schemas the CLI/HTTP server use; tool
output schemas are the `Mutation` JSON shape (also a zod schema).

We intentionally do NOT expose tools that bypass staging (no "force
apply") — the staging policy is the same regardless of which
transport called the bus.

## Resources

The MCP server publishes two resources:

- `mail://inbox/{inboxId}/threads` — current open threads, paged.
- `mail://thread/{threadId}` — full thread including messages and
  comments.

Both are read-through to the overlay-db repositories with RLS
enforced on the calling tenant.

## Streaming events

`subscriptions/notifications` carries `MailaiEvent` payloads
identical to the WebSocket bridge so an LLM client can react to
new mail or status changes in near-real-time.

## Authentication

The MCP server inherits identity from the CLI process: the keyring
token is loaded at startup. There is no per-tool re-auth.
Long-running MCP sessions refresh tokens transparently using the
stored refresh token; refresh failures kill the process so the host
client can prompt for re-login.

## Why MCP

Anthropic's MCP is the simplest cross-vendor contract for letting an
LLM operate a system: schemas in JSON-Schema, transport in stdio /
SSE, lifecycle that fits inside an editor or chat host. The tool
surface is intentionally small (one-to-one with commands) so the
LLM can reason about effects without us building bespoke prompt
engineering.
