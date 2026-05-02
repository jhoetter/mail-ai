# OAuth setup (Gmail + Outlook)

mail-ai uses [Nango](https://nango.dev) for the **initial** OAuth handshake
only. Once the user authorizes, we fetch the access + refresh token from
Nango exactly once, persist them in `oauth_accounts`, and from that point on
mail-ai talks **directly** to Google / Microsoft to refresh tokens. Nango is
not in the runtime hot path.

This split lets you:

- Use Nango's pre-configured **demo OAuth apps** in development so you don't
  have to register your own client_id with Google / Microsoft just to click
  around.
- Switch to your own OAuth client credentials in production without changing
  any code — just set the environment variables described below.

---

## TL;DR demo mode (5 minutes)

1. Sign up at [app.nango.dev](https://app.nango.dev) (free tier is enough).
2. **Integrations → New** → pick **Google Mail** → save with the
   default integration ID `google-mail`. Use Nango's demo OAuth app
   (the dashboard shows a "use Nango's demo app" toggle).
3. Repeat for **Outlook** with the integration ID `outlook`.
4. **Environment Settings → Secret Key** → copy.
5. Drop it in your shell env (or `.env.local`) and reboot:

   ```sh
   export NANGO_SECRET_KEY=sk_test_…
   make dev
   ```

6. Open <http://localhost:3200/settings/account>, click **Connect account**,
   pick Gmail or Outlook. The popup walks you through Google / Microsoft's
   normal consent screen and drops you back into mail-ai with the
   account row visible.

> Demo apps are **read-only fine for clicking around** but Google /
> Microsoft will only honor refresh_tokens that were minted by the same
> client_id that issued them. Since Nango's demo client_id/secret are not
> exposed, you cannot refresh tokens issued under demo mode after they
> expire (1h for Google, 1h for Microsoft). For anything past one hour
> of testing, switch to your own OAuth app — see "Production setup"
> below.

---

## Environment variables

| Variable                        | Required        | Purpose                                                                                                                                       |
| ------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `NANGO_SECRET_KEY`              | yes (for OAuth) | Nango secret key. Without it the API server runs in **demo mode**: the connect dialog renders setup instructions instead of a popup.          |
| `NANGO_HOST`                    | no              | Nango API base. Defaults to `https://api.nango.dev`. Override for self-hosted Nango.                                                          |
| `NANGO_GOOGLE_INTEGRATION`      | no              | Nango integration ID for Gmail. Defaults to `google-mail`.                                                                                    |
| `NANGO_OUTLOOK_INTEGRATION`     | no              | Nango integration ID for Outlook. Defaults to `outlook`.                                                                                      |
| `GOOGLE_OAUTH_CLIENT_ID`        | for refresh     | Your own Google OAuth 2.0 client ID. Required so mail-ai can refresh tokens after the initial Nango handshake.                                |
| `GOOGLE_OAUTH_CLIENT_SECRET`    | for refresh     | Matching client secret.                                                                                                                       |
| `MICROSOFT_OAUTH_CLIENT_ID`     | for refresh     | Your own Microsoft Entra ID app (client) ID.                                                                                                  |
| `MICROSOFT_OAUTH_CLIENT_SECRET` | for refresh     | Matching client secret.                                                                                                                       |
| `MICROSOFT_OAUTH_TENANT`        | no              | `common` (default) for personal + work, `consumers` for personal only, `organizations` for AAD only, or a tenant GUID for single-tenant apps. |

The frontend resolves the API origin from `NEXT_PUBLIC_MAILAI_API_URL`
(default `http://127.0.0.1:8200`).

`NANGO_SECRET_KEY` is enough to open the first consent popup, but it is
not enough for reliable local development after the initial access token
expires. Calendar sync, attachment fetches, and any provider read that
needs a refreshed token require the matching provider client id/secret
in the MailAI server environment. If those variables are missing, cached
mail can still render from Postgres while calendar sync returns no rows
and reports a missing credentials error. Add the credentials, restart the
server, then reconnect the account once so the stored refresh token was
issued by the same OAuth app.

---

## Production setup

1. Create OAuth apps in **Google Cloud Console** (OAuth client ID, Web
   application) and **Microsoft Entra ID** (App registration, Web,
   redirect URI = `https://api.nango.dev/oauth/callback`).
2. Configure the same client IDs/secrets in **both** places:
   - In the **Nango dashboard** integration settings — so the popup
     issues tokens with your branding and consent screen.
   - In **mail-ai's API env** as `GOOGLE_OAUTH_CLIENT_ID` /
     `_SECRET` and `MICROSOFT_OAUTH_CLIENT_ID` / `_SECRET` — so we can
     refresh tokens directly without going through Nango.
3. Required scopes (must be enabled in both Nango and the provider
   console):
   - **Gmail** (`google-mail` integration): `https://mail.google.com/`
     (full IMAP/SMTP access) **plus**
     `https://www.googleapis.com/auth/calendar.events` for the calendar
     plugin. The calendar scope is what lets us POST events with
     `conferenceData.createRequest` to mint Google Meet links.
   - **Outlook** (`outlook` integration): `offline_access`,
     `IMAP.AccessAsUser.All`, `SMTP.Send`, `Mail.Read`, `User.Read`,
     `Calendars.ReadWrite` and `OnlineMeetings.ReadWrite`. The last
     two are required by the calendar plugin: `Calendars.ReadWrite`
     for event CRUD and `OnlineMeetings.ReadWrite` so Graph will
     provision a Microsoft Teams meeting when an event is created
     with `isOnlineMeeting: true`.

   These are **scope additions on the existing two Nango integrations** —
   no new integration entries (e.g. `google-cal`, `microsoft-teams`)
   are needed. After widening the scopes in the Nango dashboard,
   existing connected accounts must reconnect once for the new
   permissions to be granted.

4. Restart the API:

   ```sh
   NANGO_SECRET_KEY=sk_live_…  \
   GOOGLE_OAUTH_CLIENT_ID=…    GOOGLE_OAUTH_CLIENT_SECRET=…  \
   MICROSOFT_OAUTH_CLIENT_ID=… MICROSOFT_OAUTH_CLIENT_SECRET=…  \
   pnpm --filter @mailai/server start
   ```

---

## Architecture

```
┌────────┐   1. POST /api/oauth/connect-session         ┌──────────────┐
│  Web   │ ───────────────────────────────────────────► │  mail-ai API │
│ (Next) │                                              │ (fastify)    │
│        │ ◄── { token } ────────────────────────────── │              │
│        │                                              └──────┬───────┘
│        │   2. nango.openConnectUI({ token })                 │
│        │ ──────────────► ┌──────────────┐                    │ POST /connect/sessions
│        │                 │ Nango Cloud  │ ◄──────────────────┘
│        │ ◄── connect ── │ (OAuth UI +  │
│        │   { connId }    │  callback)   │
│        │                 └──────────────┘
│        │   3. POST /api/oauth/finalize { connId }
│        │ ─────────────────────────────────────────►   ┌──────────────┐
│        │                                              │  mail-ai API │
│        │ ◄── { id, email, status: "ok" } ──────────── │              │
└────────┘                                              │  GET nango   │
                                                       │  ↳ persist   │
                                                       │   tokens     │
                                                       └──────┬───────┘
                                                              │
                              every refresh ─────────────────►│ POST {google,microsoft}
                              (no Nango) ◄────────────────────│ token endpoint
```

The persisted row in `oauth_accounts` carries:

- `access_token` + `refresh_token` (plaintext for now, encryption is a
  follow-up task — see prompt.md "Token encryption at rest").
- `expires_at` so `getValidAccessToken()` can refresh proactively in a
  5-minute skew window.
- `nango_connection_id` for traceability — we can revoke at Nango if
  needed, but no runtime call goes back to Nango.

---

## Troubleshooting

- **"Demo mode" panel keeps appearing in the Connect dialog** —
  `NANGO_SECRET_KEY` isn't reaching the API. Check that it's in the
  shell that runs `pnpm --filter @mailai/server dev`, not just the
  Next.js process.
- **Popup opens then says "blocked_by_browser"** — your browser killed
  the popup. Allow popups for `localhost:3200` and retry.
- **`google refresh failed: invalid_grant`** — the refresh token has
  been revoked or it was issued under Nango's demo client and you've
  since switched to your own. The account is automatically marked
  `needs-reauth`; the user must reconnect from the dialog.
- **Microsoft personal accounts (Outlook.com) fail with
  `unauthorized_client`** — the Entra ID app needs to be configured
  with "Personal Microsoft accounts and Work/School accounts" support
  and the `consumers` or `common` tenant.
