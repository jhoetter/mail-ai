# API

MailAI runs as a standalone subapp on `mail.<cell-domain>`.

## Health

```http
GET /api/health
```

## Inherited SSO handoff

```http
GET /?__hof_jwt=<token>
```

The server stores the token in a `hof_subapp_session` HttpOnly cookie and redirects to the clean URL.

SPA clients that authenticate only with `Authorization: Bearer` (embedded mode) should `POST /api/auth/session-cookie` once after the token is available so inline attachment images (`GET /api/attachments/:id/inline`) receive the same JWT via cookie — `<img>` cannot send Bearer headers.

## Functions and HTTP routes

The existing Fastify routes under `/api/*` remain owned by MailAI. Mutation parity with `mail-agent` is tracked in `tools.json`.
