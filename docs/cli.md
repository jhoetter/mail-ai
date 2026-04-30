# CLI

MailAI exposes `mail-agent` for the OS agent sandbox.

```sh
mail-agent inbox list
mail-agent thread read --thread-id <id>
mail-agent send --to peter@acme.com --subject "Update" --body "..."
```

Every command must emit a JSON envelope suitable for OS-agent planning.
