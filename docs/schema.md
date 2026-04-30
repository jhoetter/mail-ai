# Schema

MailAI owns the `mailai` Postgres schema.

The OS `osdaemon` role may read stable views/tables for warehouse queries:

| Object | Purpose |
|---|---|
| `mailai.emails` | Email metadata and body snippets. |
| `mailai.threads` | Thread-level summary and participant metadata. |
| `mailai.attachments` | Attachment metadata and S3 keys. |
| `mailai.calendar_events` | Calendar event summaries. |

The concrete migration to per-subapp schemas lands with the cell migration coordinator in WP-6.
