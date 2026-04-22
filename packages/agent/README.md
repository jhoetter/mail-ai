# @mailai/agent — `mail-agent` CLI + headless SDK

`mail-agent` is a JSON-by-default CLI that drives a running mail-ai server. It's the primary integration surface for AI agents and automation scripts: any tool that can shell out and parse JSON can use it.

## Install

```bash
# Inside the monorepo (auto-built by pnpm):
pnpm --filter @mailai/agent build
node packages/agent/dist/cli.js --help

# Or globally once published:
npm i -g @mailai/agent
mail-agent --help
```

## Configuration

| Env var            | Default                  | Purpose                              |
|--------------------|--------------------------|--------------------------------------|
| `MAILAI_API_URL`   | `http://127.0.0.1:8200`  | mail-ai HTTP API base URL            |
| `MAILAI_TOKEN`     | (empty; ok in dev)       | Bearer token used by `Authorization` |
| `MAILAI_WEB_URL`   | derived from `API_URL`   | Web UI base (used by `account connect`) |
| `MAILAI_RT_PORT`   | `1235`                   | Realtime WebSocket port (`watch`)    |

Equivalent CLI flags: `--api-url`, `--token`. Add `--json` (alias for `--format json`) for explicit machine output, or `--format table|markdown` for human reading.

## Output contract

- **JSON is the default.** Every command emits exactly one JSON object on stdout.
- **Errors also emit a JSON object on stdout** (in addition to a non-zero exit code), so callers that scrape stdout still get a structured error. This matches the parsing convention used by `hof-os`' `_try_parse_first_json_object` and similar shell-out wrappers.
- **Banners** (e.g. "Visit URL …" for device-flow login) go to **stderr** so they never poison the JSON stream.

| Exit code | Meaning              |
|-----------|----------------------|
| 0         | success              |
| 1         | user / validation / not-found |
| 2         | auth                 |
| 3         | network              |
| 4         | conflict             |
| 5         | internal             |

## Commands

### Auth

```bash
mail-agent auth whoami
mail-agent auth logout                       # local hint only; doesn't touch parent shell
mail-agent auth login --provider google ...  # advanced device-flow; most users connect via the web UI
```

### Accounts

```bash
mail-agent account list
mail-agent account connect --provider google      # prints a web-UI URL to complete OAuth
mail-agent account connect --provider microsoft
mail-agent account resync <oa_xxx>
mail-agent account disconnect <oa_xxx>
```

### Threads

```bash
mail-agent thread list --limit 50
mail-agent thread show <thread_id>
mail-agent thread assign <thread_id> --to <user_id>
mail-agent thread set-status <thread_id> --status resolved
mail-agent thread tag <thread_id> --add urgent --remove waiting-on-customer
```

### Messages & search

```bash
mail-agent message show <message_id> --with-headers --with-body
mail-agent search "from:boss@acme.com unread" --limit 20
```

### Comments

```bash
mail-agent comment add <thread_id> --text "Can you take this one?" --mention u_alice
```

### Send / reply

```bash
mail-agent send --to to@example.com --subject "Q3 numbers" --body-file ./draft.md
mail-agent reply <thread_id> --body-file ./reply.md
```

There is no in-app human-review queue: every command runs immediately against the user's mailbox. Agents that want a human-in-the-loop should gate their own dispatches before calling `mail-agent`.

### Idempotency

Every write command takes `--idempotency-key <key>`. If the same key + actor + command-type is dispatched twice, the second call returns the cached result instead of executing again. Use it for any retryable automation, especially `send`/`reply`.

### Watch (long-running)

```bash
mail-agent watch                                            # tail all events
mail-agent watch --event mutation                           # filter by kind
mail-agent watch --event mutation --exec './triage.sh {{thread_id}}'
```

`--exec` runs `sh -c <cmd>` per event. Available substitutions: `{{thread_id}}` (from `mutation.command.payload.threadId`) and `{{json}}` (the entire event JSON). Exec errors are logged to stderr and never kill the watch loop.

### Bulk / scripting

```bash
# Snooze everything older than 48h
mail-agent thread list --json | jq -r '.items[] | select(.unread==false) | .id' \
  | xargs -I{} mail-agent thread set-status {} --status snoozed
```

## Calling `mail-agent` from another agent (e.g. hof-os)

The `office-agent` integration in hof-os shells out via `subprocess.run` / a pooled terminal session and parses the **first JSON object on stdout**. `mail-agent` is shaped the same way:

```python
import json, subprocess

def mail_agent(args: list[str], token: str) -> dict:
    res = subprocess.run(
        ["mail-agent", "--json", *args],
        env={"MAILAI_API_URL": "http://127.0.0.1:8200", "MAILAI_TOKEN": token},
        capture_output=True, text=True, timeout=30,
    )
    # stdout always contains one JSON object, even on error.
    return json.loads(res.stdout.splitlines()[0])

threads = mail_agent(["thread", "list", "--limit", "20"], token)
if threads.get("ok") is False:
    raise RuntimeError(threads["message"])
for t in threads["items"]:
    ...
```

Things to rely on:

- exit code `0` on success, non-zero on error (codes table above)
- exactly one JSON object on the first non-empty line of stdout
- structured error shape: `{"ok": false, "error": "<code>", "message": "..."}`
- writes accept `--idempotency-key` so retries are safe

Things NOT to rely on:

- ordering of multiple JSON lines (we only emit one per command)
- specific human-readable text in error messages (the `error` code is the contract; `message` is for debugging)

## Architecture

The CLI is a thin shell over `HttpAgentClient`, which in turn talks to mail-ai's HTTP API. Mutations always go through the server's CommandBus — the CLI never writes to the DB directly, so audit and idempotency apply uniformly to CLI-, web-, and SDK-driven changes.
