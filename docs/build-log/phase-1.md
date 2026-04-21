# Phase 1 — IMAP sync, MIME, SMTP, OAuth, workers

## What shipped

- **`@mailai/imap-sync`** — `ImapConnection`, provider-aware `ImapConnectionPool`, `MailboxSyncer` (initial + CONDSTORE delta + UIDVALIDITY full-resync trigger), `IdleListener` (with NOOP fallback), `Outboxer` (STORE/MOVE/EXPUNGE/APPEND), `appendRawToSent`, BullMQ workers (`startSyncWorker`, `startOutboxWorker`).
- **`@mailai/mime`** — `parseMessage` (mailparser-based; opaque-part hooks), `composeMessage` (libmime headers; multipart/alternative + multipart/mixed assembly), `thread` (JWZ algorithm), HTML sanitiser stub.
- **`@mailai/smtp-send`** — `SmtpSender` (nodemailer; password + XOAUTH2; `verify()` for diagnostics), `SendOutcome` carries the actual raw bytes so `imap-sync` can APPEND-to-Sent.
- **OAuth2** — `GoogleOAuth` and `MicrosoftOAuth` with code exchange + refresh.

## Specs delivered alongside

- `spec/shared/architecture.md`, `data-model.md`, `command-bus.md`, `plugin-system.md`, `security-model.md`, `agent-api.md`
- `spec/imap-sync/analysis.md`, `architecture.md`, `algorithms.md`, `edge-cases.md`, `test-strategy.md`

## Validation surface

- Unit tests live next to each module (e.g. `outboxer.test.ts`, `threading.test.ts`).
- Integration tests live in `tests/integration/src/`. Coexistence + overlay-isolation tests are gated on `MAILAI_GREENMAIL=1`; perf tests on `MAILAI_PERF=1`. OAuth refresh test runs unconditionally with stubs.

## Architecture invariants enforced

`scripts/check-architecture.mjs` now also gates `bullmq` and `ioredis` (allowed only inside `imap-sync` and `server`). Verified after every change in this phase.
