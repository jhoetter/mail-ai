# Phase 5 — Frontend / embed build log

## What shipped (apps/web)

- `apps/web/app/lib/api.ts` — host adapter that constructs the
  shared `HttpAgentClient` with browser-side or env-driven token.
- `apps/web/app/lib/use-shortcut.ts` — keyboard-shortcut hook with
  the safety rails described in `spec/frontend/keyboard.md`
  (text-input filtering, modifier-aware matching).
- `apps/web/app/pending/page.tsx` — pending-approvals queue with
  approve/reject handlers and the `y`/`n` shortcut bindings.
  Auto-refreshes via 5s polling; replaced with WebSocket events
  in Phase 5 Validate.
- `apps/web/app/search/page.tsx` — full-text search calling
  `/api/search` (server route to be wired in Phase 5 Validate).
- `apps/web/app/settings/account/page.tsx` — account list
  scaffold with "Connect account" CTA placeholder.
- `apps/web/package.json` now declares `@mailai/agent` and
  `@mailai/core` as workspace deps so the pages can import the
  shared client and types directly.

## What shipped (`@mailai/react-app`)

- `MailAiApp` component is now the single public entry point per
  `spec/frontend/embed.md`. Sub-components remain re-exported for
  back-compat but the host contract narrows around `MailAiApp`.
- `useMailAiHost` exposes the host hooks to children for auth /
  navigation requests.
- `build.mjs` now emits `MailAiApp.tsx` as a top-level entry
  alongside the existing component entries, so non-bundling hosts
  can `<script type="module" src=".../MailAiApp.js">`.

## What shipped (`apps/realtime-server`)

No changes in Phase 5 build — the existing scaffold already
exposes the presence channel that the web shell consumes. WS
fan-out for command bus mutations comes online in Phase 5
Validate when we wire the broadcaster from `@mailai/server`.

## Why this scope

The build for Phase 5 stays narrow on purpose:

- The Inbox + ThreadView + Composer scaffolds from Phase 0 are
  already wired against the design system; this phase adds the
  routes that prove the overall shell ("pending", "search",
  "settings/account") and the embed component that proves the
  bundle is real.
- All keyboard shortcuts go through the same hook so the
  accessibility checklist in `spec/frontend/accessibility.md` has
  exactly one chokepoint to audit.

## Validate

- `apps/web/playwright.config.ts` — Playwright config gated on
  `MAILAI_E2E=1`, `baseURL` configurable via `MAILAI_WEB_URL`.
- `apps/web/e2e/pending-keyboard.spec.ts` — exercises the
  `y`/`n` shortcuts on the pending-approvals page, asserting the
  documented keyboard contract.
- `apps/web/e2e/compose-send.spec.ts` — composes a message and
  validates Greenmail delivery (additionally gated on
  `MAILAI_GREENMAIL=1`).
- `apps/web/e2e/realtime-multi-session.spec.ts` — drives two
  Chromium contexts and checks that one session sees the other's
  status flip within the documented 2s SLA.
- `apps/embed-host/` — Vite host that consumes
  `@mailai/react-app`'s `MailAiApp` directly. Smoke-tests the
  embed contract from `spec/frontend/embed.md`: `pnpm --filter
  @mailai/embed-host dev` brings the embed up against a pretend
  host.
- `scripts/release-tarballs.mjs` — produces the two artifacts
  documented in `docs/release-pipeline.md` plus a
  `mailai.lock.json` snapshot with shasums.

## Known gaps deferred

- WebSocket-driven page updates (replaces the 5s polling).
- Playwright e2e that runs the keyboard shortcut surface,
  composer-via-Greenmail send, and a multi-session real-time
  case.
- `apps/embed-host` Vite harness consuming the
  `@mailai/react-app` bundle to prove the embed contract.
- Release tarball production for `@mailai/react-app` and
  `mail-agent` CLI.
