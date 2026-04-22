# Provider port model

mail-ai talks to several mailbox-shaped backends — Gmail, Microsoft
Graph today; IMAP, CalDAV and others on the roadmap. Every one of
them does roughly the same thing in spectacularly different ways. The
codebase deals with that by funnelling all provider traffic through a
small set of **ports** in `@mailai/providers`. Concrete adapters
(Google, Outlook) live in `@mailai/oauth-tokens/src/adapters`.
Everything else — handlers, routes, schedulers, the web app —
imports the ports and the registry that holds the adapters.

If you only read one paragraph: **never branch on
`account.provider === "google-mail"` outside an adapter**. Use the
registry, look at the adapter's `capabilities`, and let the adapter
do the work. The architecture check
(`scripts/check-architecture.mjs`) and the ESLint
`no-restricted-imports` rule both fail CI when this rule is broken.

---

## The four ports

All four live in `packages/providers/src/`. Each one ships with:

1. A normalized type module (`types.ts`) — the shape the rest of the
   app sees.
2. A port (`port.ts`) — a `MailProvider` / `CalendarProvider` /
   `ContactsProvider` / `PushProvider` interface plus a
   `*Capabilities` record that declares what the adapter can do.
3. A registry (`registry.ts`) — `for(providerId)` returns the
   adapter; throws or returns `null` for unknown ids depending on the
   port.

| Port              | What it abstracts                      | Adapters                                                            |
| ----------------- | -------------------------------------- | ------------------------------------------------------------------- |
| `MailProvider`    | Folders, messages, send, delta sync    | `GoogleMailAdapter`, `OutlookMailAdapter`                           |
| `PushProvider`    | Server-push subscriptions              | `GoogleMailPushAdapter`, `OutlookMailPushAdapter`                   |
| `CalendarProvider`| Calendars, events, RSVP, conferencing  | `GoogleCalendarAdapter`, `OutlookCalendarAdapter`                   |
| `ContactsProvider`| Address-book sources, frequent people  | `GoogleContactsAdapter`, `OutlookContactsAdapter`                   |

### Capabilities, not provider ids

Every port ships a `*Capabilities` shape that the adapter populates
once. Callers that need to gate UI or skip a sync source ask the
capability, not the id:

```ts
const adapter = calendarProviders.for(account.provider);
const supportsMeet = adapter.capabilities.conferences.includes("google");
if (supportsMeet) showMeetOption();
```

If you find yourself writing
`account.provider === "google-mail" ? showA : showB`, the right move
is almost always to add a capability flag to the port and have each
adapter set it.

### Normalized types

Every port returns a normalized shape. Adapters map provider wire
formats *into* this shape; nothing else in the codebase ever sees the
raw provider response. Examples:

- `NormalizedMessage` — `{ providerMessageId, threadId, subject,
  participants, wellKnownFolder, labels, ... }`. Folder identity is
  always carried in the dedicated `wellKnownFolder` enum (see
  `Phase 3` in the build log); `labels` only ever contains user-visible
  labels/categories.
- `NormalizedCalendar` / `NormalizedEvent` — provider-agnostic
  fields. Conferencing is captured as a `conference` discriminator
  the adapter knows how to round-trip.
- `NormalizedContact` — `{ providerContactId, source, displayName,
  emails, lastInteractionAt? }` where `source` is one of
  `"my" | "other" | "people"`. Adapters return `[]` for sources they
  don't support.
- `PushSubscription` — opaque `clientState`/`channel` payload an
  adapter can later use to renew or cancel the subscription.

---

## Where each piece lives

```
packages/providers/                  ports + normalized types + registries
  src/mail/      port.ts, registry.ts, types.ts
  src/calendar/  port.ts, registry.ts, types.ts
  src/contacts/  port.ts, registry.ts, types.ts, helpers.ts
  src/push/      port.ts, registry.ts, types.ts

packages/oauth-tokens/               OAuth + token refresh + adapters
  src/refresher.ts                   getValidAccessToken (used everywhere)
  src/google.ts, microsoft.ts        OAuth code-exchange helpers
  src/userinfo.ts                    minimal /me lookups for the connect flow
  src/gmail.ts, graph.ts,            provider-specific REST clients
    send.ts, calendar.ts,            (private — only adapters import these)
    contacts.ts
  src/adapters/                      MailProvider/PushProvider/...
    google-mail.ts, outlook-mail.ts  implementations. Every adapter wraps
    google-calendar.ts, ...          one or more of the private REST
                                     clients above and exposes the port.

packages/server/src/providers.ts     buildMailProviderRegistry(),
                                     buildPushProviderRegistry(),
                                     buildCalendarProviderRegistry(),
                                     buildContactsProviderRegistry().
                                     Constructed once in server.ts and
                                     handed to every handler/route.
```

The `@mailai/oauth-tokens` package only re-exports from its public
surface (`refresher`, `xoauth2`, `userinfo`, `adapters/*`,
`google.ts`/`microsoft.ts` for OAuth code exchange, plus the shared
`types.ts`). The provider-specific REST clients (`gmail.ts`,
`graph.ts`, `send.ts`, `calendar.ts`, `contacts.ts`) are deliberately
*not* re-exported. CI fails if a non-adapter file imports them.

---

## The adapter contract

Adapters are plain classes that implement a port. Two requirements:

1. **No leaking provider state** — the only thing flowing in and out
   of a method is normalized types and (where required) an
   `accessToken` plus a `fetchImpl` for tests.
2. **Set every capability flag honestly.** The contract test suite
   (`packages/providers/src/mail/contract.ts`, executed by each
   adapter's vitest file) checks the basics. Lying about a capability
   is what causes the calendar UI to offer Google Meet on an Outlook
   account or push to silently no-op on Gmail.

Skeleton:

```ts
export class GoogleMailAdapter implements MailProvider {
  readonly id = "google-mail" as const;
  readonly capabilities = GOOGLE_MAIL_CAPABILITIES;

  async listFolders(args) { /* ...wrap gmail.ts... */ }
  async listMessages(args) { /* ...paginate... */ }
  async pullDelta(args) { /* ...users.history.list... */ }
  async send(args) { /* ...send.ts... */ }
  async normalize(raw) { /* ...emit NormalizedMessage... */ }
}
```

---

## Adding a new provider

The end-to-end checklist for, say, an IMAP/SMTP provider:

1. Pick which port(s) you implement. Most providers start with
   `MailProvider`; calendars/contacts/push come later.
2. Add a new module under
   `packages/oauth-tokens/src/adapters/<provider>-mail.ts` that
   implements the port. Provider-specific REST/IMAP code stays inside
   that module (or alongside it under `oauth-tokens/src/`, behind the
   port).
3. Set every `MailProviderCapabilities` flag truthfully. If your
   provider can't do server-push, *don't* add a `PushProvider`
   adapter for it; the scheduler will fall back to polling
   automatically.
4. Register the adapter in
   `packages/server/src/providers.ts::buildMailProviderRegistry`.
5. If your provider needs a new OAuth flow, extend
   `packages/oauth-tokens/src/types.ts::ProviderCredentials` and the
   onboarding routes.
6. Add a row to the `MailProviderId` union in
   `@mailai/providers/types.ts` *and* to the matching column type in
   `packages/overlay-db/src/schema.ts::oauthMessageProvider`. Run the
   migration generator.
7. Run `pnpm --filter @mailai/providers test` — the contract suite
   should immediately tell you if a method or capability is missing.
8. Run `node scripts/check-architecture.mjs` to confirm you didn't
   accidentally import a private REST module from a non-adapter file.

That's it. The handler layer, the scheduler, the views compiler, the
web app and the push fan-out all consume the registry, so a new
provider should not require any branching code outside its adapter.

---

## When you do need provider-specific code

The honest answer: only inside `packages/oauth-tokens/src/adapters/`.
Everywhere else, prefer one of these escape hatches in order:

1. **Add a capability flag.** This is the right move ~95% of the
   time.
2. **Add a method to the port.** If the new behaviour is genuinely
   per-provider but every provider has its own answer, give the port
   a method.
3. **Branch on capability in the caller.** Acceptable for UI gating
   ("show Meet vs Teams") because the alternative — three layers of
   abstraction for one button — costs more than it saves.

Direct branching on `account.provider === "..."` outside the adapter
layer is the failure mode the architecture check exists to catch.

---

## Related docs

- `docs/push-setup.md` — operator setup for Gmail/Graph push.
- `docs/build-log/phase-2.md` through `phase-9.md` — phase-by-phase
  history of how the port model was rolled in.
