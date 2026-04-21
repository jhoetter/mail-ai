# Security model (shared)

## Threat model

| Threat | Mitigation |
| --- | --- |
| Cross-tenant data leak | RLS + `tenant_id` everywhere; integration test boots two tenants and asserts no row crossing. |
| Stolen IMAP password from disk | `accounts.credential_blob` is AES-256-GCM with a per-tenant DEK wrapped by a KMS-managed master key. |
| Replay of a captured Bearer token | Tokens are short-lived (60 min); refresh requires the refresh token (per provider). |
| Smuggling overlay metadata into IMAP | Architecture rule + isolation snapshot test. |
| Agent sends mail you didn't sanction | Staging policy: `mail:send`/`reply`/`forward` are never auto-applied from agents. |
| MCP-driven tool consumes more than allowed | OAuth device-flow scopes per agent; bus enforces RBAC at the actor level. |
| Compromised browser steals attachments | Attachments are streamed through an authenticated mail-ai endpoint; the host never sees the S3 bucket directly. |

## Encryption-at-rest

- **Postgres**: standard volume encryption (assumed) + per-row encryption for `credential_blob`. Bodies are stored as object refs; the bodies themselves live in MinIO/S3 with bucket-level SSE.
- **Object store**: server-side encryption (KMS or SSE-S3).
- **Backups**: same KMS keys.

## Encryption-in-transit

- HTTPS-only public endpoints (HSTS).
- IMAPS (993) / SMTPS (465) preferred; STARTTLS accepted for legacy IMAP/SMTP. Plain-text is rejected.
- WebSocket upgrades over HTTPS only (`wss://`).

## OAuth — Microsoft tenants

Personal MS accounts: user consent suffices.

Enterprise tenants: admin consent required for `https://outlook.office.com/IMAP.AccessAsUser.All` and `SMTP.Send`. Document this in onboarding; the Phase-1 device-flow CLI surfaces the admin-consent URL when consent is missing.

## Row-level security

Every multi-tenant table has an RLS policy:

```sql
CREATE POLICY tenant_isolation ON {table}
  USING (tenant_id = current_setting('mailai.tenant_id'));
```

The server sets `mailai.tenant_id` at the start of each request transaction. A handler that forgets this fails closed (zero rows). Verified by an integration test in Phase 2 Validate.

## Secrets handling in dev / CI

- Dev: `.env.local` (gitignored) holds dummy OAuth client IDs.
- CI: GitHub Secrets, scoped to release workflows only.
- Never commit a real secret. The `pnpm verify` step includes a regex sweep for known patterns (`AKIA…`, `xoxb-…`, `ghp_…`).

## Out of scope for v1

- BYOK (bring-your-own-key) for tenant-managed encryption.
- Hardware security modules.
- DLP integration (the `onBeforeSend` host hook is the seam for hof-os to add DLP later).
