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
  web/                      Vite + React Router reference UI shell
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
  ui/                       Shared React primitives (used by apps/web only)
  design-tokens/            Tailwind preset + tokens
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

## Hosting in hof-os

The user-facing mail UI ships natively from
[`hof-components/modules/mailai`](https://github.com/jhoetter/hof-os/tree/main/packages/hof-components/modules/mailai)
inside `hof-os` (Approach C, April 2026). This repo is the
**backend service** for that UI: the Fastify server in
`packages/server/` exposes the REST + WS contract that the data-app's
`/api/mail/*` proxy forwards to with a single `hof_token` Bearer.

The standalone `apps/web` Vite app remains as a developer harness so
you can iterate on backend behaviour against a real React surface in
isolation. There is no longer a publishable `@mailai/react-app`
embed bundle — the embed React surface lives in hof-os.

To develop the UI against a local mail-ai backend, run `make dev` here
and then in `hof-os` run `MAILAI_LOCAL_PATH=$(pwd) make dev` so the
docker-compose overlay rebuilds the sidecar from this checkout.

## Consumed Via Tarball URL

The hofOS host consumes the built UI package from GitHub Releases rather than copying source trampolines into customer cells. Each release attaches `mailai-ui-<version>.tgz`, installable with:

```json
"@mailai/hofos-ui": "https://github.com/jhoetter/mail-ai/releases/download/v0.1.0/mailai-ui-0.1.0.tgz"
```

For local iteration, run `pnpm run build:dist` or point hofOS' local-dev override at `packages/hofos-ui`.
