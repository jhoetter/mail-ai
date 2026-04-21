# Phase 4 — Agent SDK / CLI / MCP build log

## What shipped

- **`@mailai/core` — idempotency dedup**
  `CommandBus` keeps a per-`(actor, type, idempotencyKey)` cache and
  returns the previously-stored mutation on repeat dispatch. Used by
  the SDK + CLI to make retries safe.
- **`@mailai/agent` — SDK**
  - `MailAgent.applyCommand` (idempotency-aware, tenant/inbox-aware).
  - `MailAgent.applyCommands(inputs, { stopOnError })` returning a
    `BatchResult` with per-command status, `appliedCount`, and
    `failedAt`. Matches the contract in
    `spec/agent/batch-atomicity.md`.
  - `getPendingMutations` / `approveMutation` / `rejectMutation`
    delegated to the bus.
- **`@mailai/agent` — HTTP transport**
  `HttpAgentClient` covers `applyCommand`, `listPending`, `approve`,
  `reject`, `whoami`. Translates HTTP status codes into
  `MailaiError` codes (`auth_error`, `conflict_error`, etc.).
- **`@mailai/agent` — OAuth device flow**
  `oauth-device.ts` implements RFC 8628 with a pluggable `fetch`,
  `sleep`, and `clock` so the validate suite can drive both happy
  and sad paths against a mocked endpoint.
- **`@mailai/agent` — CLI**
  Real subcommands: `auth login`, `auth whoami`, `apply <type>`,
  `thread assign`, `thread set-status`, `comment add`,
  `pending list`, `pending approve`, `pending reject`, `mcp`. All
  routed through `HttpAgentClient`. Exit codes match
  `spec/agent/cli.md` (1 user, 2 auth, 3 network, 4 conflict, 5
  internal).
- **CLI output schemas**
  `cli-output-schemas.ts` declares the JSON shape every subcommand
  prints, so Phase 4 Validate can assert pipe-safety.
- **`@mailai/server` — pending-mutation endpoints**
  `GET /api/mutations/pending`, `POST /api/mutations/:id/approve`,
  `POST /api/mutations/:id/reject`, `GET /api/whoami`. Idempotency
  and inbox headers are now respected on `POST /api/commands`.

## Why this scope

Per `spec/agent/interface.md` the SDK is the seam: the web UI uses
it in-process, the CLI uses it over HTTP, and the MCP server uses
the CLI's machinery. Building the headless SDK + transport + CLI
together is the smallest unit that proves the contract is real.
The OAuth device flow is the only auth path that survives the
"agent runs in a terminal with no browser context" constraint, so
it ships in this phase even though token storage (keyring) is
deferred to Phase 5 build.

## Known gaps (deliberately deferred)

- **MCP tool wiring**: the `mail-agent mcp` subcommand currently
  only registers a `tools/list` handler stub; full bidirectional
  tool dispatch lands in Phase 4 Validate alongside the schema
  fuzzer.
- **Keyring storage**: device-flow output is printed to stdout; the
  CLI does not yet write `keytar` entries. The Phase 5 build adds
  that wrapper around `auth login`.
- **Pending-mutation idempotency**: the bus dedups in-memory; for a
  multi-process server a Redis-backed `MutationStore` is wired in
  Phase 5 build.

## Validate

`packages/agent/src/*.test.ts` covers:

- `agent.batch.test.ts` — `applyCommands` ordering, `appliedCount`,
  `failedAt`, `abortedRest`, and `stopOnError={true,false}`.
- `agent.idempotency.test.ts` — same key returns cached mutation
  without invoking the handler twice; different keys do not.
- `staging.test.ts` — agent-source `mail:send` lands as `pending`
  with no handler call; `approveMutation` runs the handler and
  records `approvedBy`; `rejectMutation` flips status and skips the
  handler; humans never stage.
- `oauth-device.test.ts` — happy path, `authorization_pending` +
  `slow_down` polling, `access_denied` rejection, and deadline
  expiry.
- `cli-output-schemas.test.ts` — every documented JSON output shape
  parses against its zod schema.

These run headlessly via `pnpm --filter @mailai/agent test`. No
real HTTP server, no real OAuth provider, no browser.

