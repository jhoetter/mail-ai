# `mail-agent` CLI (Phase 4 spec)

Headless command-line frontend to the `MailAgent` SDK. Built with
[`commander`](https://github.com/tj/commander.js) so subcommands,
help, and option parsing follow a stable convention. Output format
is selectable per call: `--json` (default for non-TTY), `--table`
(default for TTY), `--markdown` (for embedding in chat / docs).

## Subcommand surface

```
mail-agent
  auth
    login                        Start RFC 8628 device-code flow
    logout                       Wipe local credentials
    status                       Print active identity
  inbox
    list                         Show inboxes the user belongs to
  thread
    list  --inbox <id> [--status open|snoozed|resolved|archived]
    show  <threadId>             Print thread + recent messages
    assign <threadId> <userId>
    set-status <threadId> <status>
    comment <threadId> <text>    (mentions auto-extracted)
  mail
    send  <accountId> --to ... --subject ... [--body-file -]
    reply <threadId> [--body-file -]
    mark-read <accountId> <mailbox> <uid>
  pending
    list                         Pending mutations awaiting review
    approve <mutationId>
    reject  <mutationId> [--reason ...]
  account
    list
    connect <provider> <address>
    disconnect <accountId>
  mcp                            Run as MCP stdio server (see ./mcp.md)
```

## Output contract

Every subcommand:

- Returns exit code `0` on success, `1` on validation error,
  `2` on auth error, `3` on remote IMAP/SMTP failure, `4` on
  conflict (e.g., reject of an already-applied mutation), `5` on
  internal error.
- In `--json` mode, prints a single JSON object whose schema is
  declared in `packages/agent/src/cli-output-schemas.ts` (one
  schema per subcommand).
- In `--table`/`--markdown` modes, prints a deterministic, sorted
  rendering with stable column order.

The schema-validated JSON output is what the Phase 4 Validate suite
asserts against; this is how we keep the CLI safe for piping into
other tools.

## Configuration

The CLI reads, in order of precedence:

1. CLI flags.
2. Environment variables (`MAILAI_*`).
3. `~/.config/mail-agent/config.json` (per-user).
4. Tenant defaults from the server.

There is no global config file under `/etc`. We don't want
multi-user shared CLI defaults silently changing behaviour.

## Auth storage

OAuth refresh tokens are stored in the OS keyring via
[`keytar`](https://github.com/atom/node-keytar) under service
`mail-agent` and account `<userId>@<tenantId>`. There is no
plaintext fallback. If keyring access fails, the CLI exits with
auth-error (2) and prints a remediation hint.
