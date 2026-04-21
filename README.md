# mail-ai

**AI-native email collaboration platform — IMAP overlay.**

mail-ai is a server-side overlay over existing IMAP/SMTP mailboxes. It does not run a mail server and does not replace Outlook, Apple Mail, or Gmail. Users keep their mailboxes at Google, Microsoft, or any IMAP provider; mail-ai layers collaboration features (assignment, comments, status, tags, agent actions) on top, and every state change flows through a single command bus that humans and AI agents drive equally.

See [`prompt.md`](prompt.md) for the full product brief and [`docs/build-log/`](docs/build-log/) for build decisions.

## Quick start

```bash
pnpm install
make stack-up      # Postgres, Redis, Dovecot, Greenmail, MinIO
pnpm verify        # lint + typecheck + tests + build
make dev           # http://localhost:3200
```

## Layout

```
apps/
  web/                      Next.js 15 reference UI shell
  realtime-server/          Dev-only ws server (presence + collision indicator)
packages/
  core/                     Command bus, mutations, snapshots, plugin registry
  mime/                     MIME parse/compose, opaque preservation, threading helpers
  imap-sync/                IMAP connection pool, IDLE, CONDSTORE delta sync
  smtp-send/                SMTP submission + APPEND-to-Sent
  overlay-db/               Postgres schema (Drizzle), repositories, JWZ threading, FTS
  collaboration/            Assignment, status, comments, tags, audit log, RBAC
  agent/                    Headless MailAgent SDK + mail-agent CLI + MCP server
  server/                   Fastify HTTP + ws (the only network surface)
  ui/                       Shared React primitives
  design-tokens/            Tailwind preset + tokens
  react-app/                Publishable embed package (esbuild bundle)
spec/                       Living specification (per phase + shared)
fixtures/                   MIME samples + mailbox dumps
tests/                      Integration + agent + overlay test suites
infra/docker/               Dev stack (compose), Dockerfiles, Dovecot/Greenmail seeds
docs/build-log/             Phase build logs
scripts/                    check-architecture, bundle-dry-run, bump-version
```

## Architecture invariants

1. **Overlay, not replacement.** IMAP is the source of truth for mail; our DB is the source of truth for overlay metadata.
2. **Commands are the only mutation path.** Direct DB or IMAP mutation is forbidden outside the parser/sync/bus layers (enforced by `pnpm architecture`).
3. **Headless-first.** Every package below `apps/` runs in Node with zero DOM.
4. **No smuggling.** We never store overlay metadata in IMAP — no fake headers, no hidden folders.
5. **IMAP coexistence integrity.** Every change we make must be visible to a parallel client (Outlook, Gmail web) within seconds.

See [`docs/embedding.md`](docs/embedding.md) for how mail-ai will later embed into hof-os via the same release-tarball pattern as office-ai.
