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

## Functions and HTTP routes

The existing Fastify routes under `/api/*` remain owned by MailAI. Mutation parity with `mail-agent` is tracked in `tools.json`.
