# overlay-db — attachment streaming

## Storage

Attachments live in S3-compatible object storage (MinIO in dev). Object keys:

```
t/{tenant_id}/m/{message_id}/raw.eml             ← full RFC 822 (canonical)
t/{tenant_id}/m/{message_id}/text.txt            ← plain-text body
t/{tenant_id}/m/{message_id}/html.html           ← HTML body
t/{tenant_id}/m/{message_id}/att/{attachment_id} ← per-attachment payload
```

We store raw + decoded so we can:

- re-parse on demand if our parser improves,
- serve attachments without re-running mailparser.

## Streaming download

The HTTP route in `packages/server` streams from S3 directly back to the client through a signed URL **served by mail-ai itself** (not direct S3 presigned URLs) so:

- the host (hof-os) does not need bucket creds,
- we can enforce RBAC + audit per download,
- we can cap bandwidth per tenant.

```
GET /api/messages/:msgId/attachments/:attId
  → Auth check (session + RBAC)
  → Audit "attachment-downloaded"
  → Stream s3.getObject(...).Body to res
```

## Streaming upload

Composer attachments are uploaded chunked via:

```
POST /api/uploads → returns uploadId
PUT  /api/uploads/:uploadId  (multipart chunks)
POST /api/uploads/:uploadId/complete
```

This is identical to what we'd do in hof-os, so the embed package can re-use the same flow.

## Inline images (`cid:`)

When sending: composer rewrites every `<img src="cid:foo">` to reference the
attachment with `Content-ID: <foo>` and we add the file as an inline part.

When viewing: parser produces a `cid` map; the UI rewrites `cid:` URLs to
`/api/messages/:msgId/cid/:cid` which streams from S3 with `Content-Type` from
the `attachments` row.

## Size and quotas

- Per-message body fetched only if `size <= MAILAI_BODY_MAX_BYTES` (default 25MB).
- Larger messages get `body_skipped = true` and a "fetch on demand" UI control.
- Tenant-level total quota is enforced at upload time and visible in admin UI.
