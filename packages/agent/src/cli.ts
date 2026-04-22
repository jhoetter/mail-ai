#!/usr/bin/env node
// mail-agent CLI. Pipeable, scriptable, JSON-by-default.
//
// Designed for two consumers:
//   1. Humans at a terminal (`--format table` or `--format markdown`)
//   2. 3rd-party AI agents that shell out to us (e.g. hof-os'
//      run_office_agent pattern). Those parse the FIRST JSON object
//      emitted on stdout, treat exit 0 as success, and may merge
//      stdout+stderr into one stream. So:
//
//        - default output is JSON, one object on stdout
//        - errors ALSO emit a single JSON object on stdout AND set a
//          non-zero exit code, so callers that only inspect stdout
//          still get a structured error
//        - banners (e.g. "Visit URL ..." for device-flow login) go to
//          stderr so they never poison the JSON stream
//        - --json is a shorthand for --format json (matches the
//          office-agent convention)
//
// Exit codes (per spec/agent/cli.md):
//   0 success
//   1 user / validation error
//   2 auth error
//   3 network error
//   4 conflict
//   5 internal

import { readFile } from "node:fs/promises";
import { Command as Cli } from "commander";
import { isMailaiError, MailaiError, type Mutation } from "@mailai/core";
import { HttpAgentClient } from "./http-client.js";
import { startMcpStdio } from "./mcp.js";
import { runDeviceFlow } from "./oauth-device.js";

interface Globals {
  format: "json" | "table" | "markdown";
  json: boolean;
  apiUrl: string;
  token: string;
}

const program = new Cli();
program
  .name("mail-agent")
  .description("mail-ai headless agent CLI — drive mail-ai from any AI agent or shell pipeline")
  .version("0.0.0")
  .option("--format <fmt>", "json|table|markdown", "json")
  .option("--json", "shorthand for --format json (matches office-agent convention)", false)
  .option(
    "--api-url <url>",
    "mail-ai HTTP API base URL",
    process.env["MAILAI_API_URL"] ?? "http://127.0.0.1:8200",
  )
  .option("--token <token>", "Bearer token", process.env["MAILAI_TOKEN"] ?? "");

function client(): HttpAgentClient {
  const g = program.opts<Globals>();
  // Token isn't required against the dev server (stub identity), so we
  // pass the empty string through. Real deployments will reject it
  // with a 401, which our HTTP client maps to auth_error / exit 2.
  return new HttpAgentClient({ baseUrl: g.apiUrl, token: g.token });
}

function chosenFormat(): "json" | "table" | "markdown" {
  const g = program.opts<Globals>();
  return g.json ? "json" : g.format;
}

function emit(payload: unknown): void {
  const fmt = chosenFormat();
  if (fmt === "json") {
    process.stdout.write(JSON.stringify(payload) + "\n");
    return;
  }
  if (fmt === "markdown") {
    process.stdout.write("```json\n" + JSON.stringify(payload, null, 2) + "\n```\n");
    return;
  }
  process.stdout.write(formatTable(payload) + "\n");
}

function formatTable(payload: unknown): string {
  // Unwrap a single { items: [...] } envelope so `mail-agent thread list
  // --format table` doesn't show the metadata wrapper.
  const inner =
    payload && typeof payload === "object" && "items" in payload
      ? (payload as { items: unknown }).items
      : payload;
  if (Array.isArray(inner)) {
    if (inner.length === 0) return "(empty)";
    const cols = Object.keys(inner[0] as object);
    const header = cols.join("\t");
    const rows = inner.map((r) =>
      cols.map((c) => stringifyCell((r as Record<string, unknown>)[c])).join("\t"),
    );
    return [header, ...rows].join("\n");
  }
  return JSON.stringify(payload, null, 2);
}

function stringifyCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function ok(m: Mutation) {
  return { ok: true, mutation: shapeMutation(m) };
}

function shapeMutation(m: Mutation) {
  return {
    id: m.id,
    status: m.status,
    command: { type: m.command.type, actorId: m.command.actorId, timestamp: m.command.timestamp },
    createdAt: m.createdAt,
    ...(m.error ? { error: m.error } : {}),
  };
}

// ---------------------------------------------------------------- AUTH

const auth = program.command("auth").description("Authentication");

auth
  .command("login")
  .description("Authenticate via OAuth2 RFC 8628 device-code flow (advanced; most users connect via the web UI)")
  .requiredOption("--provider <provider>", "google|microsoft|generic")
  .requiredOption("--client-id <id>", "OAuth client id")
  .requiredOption("--device-endpoint <url>")
  .requiredOption("--token-endpoint <url>")
  .option("--scope <scope>", "OAuth scope", "openid email offline_access")
  .action(
    async (opts: {
      provider: string;
      clientId: string;
      deviceEndpoint: string;
      tokenEndpoint: string;
      scope: string;
    }) => {
      const result = await runDeviceFlow(
        {
          deviceAuthEndpoint: opts.deviceEndpoint,
          tokenEndpoint: opts.tokenEndpoint,
          clientId: opts.clientId,
          scope: opts.scope,
        },
        (code) => {
          // Banner goes to stderr so it never lands inside the JSON
          // stream that callers parse.
          process.stderr.write(
            `Visit ${code.verification_uri} and enter code: ${code.user_code}\n`,
          );
        },
      );
      emit({
        ok: true,
        provider: opts.provider,
        access_token: result.tokens.access_token,
        refresh_token: result.tokens.refresh_token ?? null,
        expires_in: result.tokens.expires_in,
      });
    },
  );

auth
  .command("whoami")
  .description("Print the authenticated identity")
  .action(async () => {
    emit(await client().whoami());
  });

auth
  .command("logout")
  .description("Clear local credentials (env vars are not modified)")
  .action(() => {
    // We intentionally don't touch the environment — that would mutate
    // the parent shell's state. We emit a confirmation so a wrapper
    // script can `eval $(mail-agent auth logout --shell)` later.
    emit({
      ok: true,
      hint: "Unset MAILAI_TOKEN in your shell to fully sign out (`unset MAILAI_TOKEN`).",
    });
  });

// ------------------------------------------------------------ ACCOUNTS

const account = program.command("account").description("Connected mail accounts");

account
  .command("list")
  .description("List connected OAuth accounts")
  .action(async () => {
    const items = await client().listAccounts();
    emit({ items, count: items.length });
  });

account
  .command("connect")
  .description("Begin connecting a Gmail or Outlook account (OAuth runs in the browser)")
  .requiredOption("--provider <provider>", "google|microsoft")
  .action(async (opts: { provider: string }) => {
    const provider = opts.provider.toLowerCase();
    if (provider !== "google" && provider !== "microsoft") {
      throw new MailaiError("validation_error", "--provider must be 'google' or 'microsoft'");
    }
    // OAuth requires a browser. The CLI cannot complete the flow
    // headlessly without provider-specific device-flow client ids that
    // most users won't have. Print the URL to the web UI's connect
    // dialog and let the user finish the popup there. The web UI uses
    // the same /api/oauth/finalize endpoint we'd hit, so the resulting
    // account is identical.
    const g = program.opts<Globals>();
    const webBase = process.env["MAILAI_WEB_URL"] ?? deriveWebUrl(g.apiUrl);
    const url = `${webBase}/settings/account?connect=${provider === "google" ? "google-mail" : "outlook"}`;
    emit({
      ok: true,
      provider,
      action: "open_browser",
      url,
      hint: "Open the URL in your browser to complete the OAuth flow. Run `mail-agent account list` afterwards to confirm.",
    });
  });

account
  .command("disconnect <id>")
  .description("Remove a connected account (revokes refresh token; mailbox is untouched)")
  .action(async (id: string) => {
    await client().deleteAccount(id);
    emit({ ok: true, id });
  });

account
  .command("resync <id>")
  .description("Trigger a fresh sync for one account")
  .action(async (id: string) => {
    const r = await client().resyncAccount(id);
    emit({ ok: true, id, ...r });
  });

// ------------------------------------------------------------- THREADS

const thread = program.command("thread").description("Read and act on threads");

thread
  .command("list")
  .description("List recent threads")
  .option("--limit <n>", "max items", "50")
  .action(async (opts: { limit: string }) => {
    const items = await client().listThreads({ limit: Number(opts.limit) || 50 });
    emit({ items, count: items.length });
  });

thread
  .command("show <threadId>")
  .description("Show one thread with its messages")
  .action(async (threadId: string) => {
    emit(await client().getThread(threadId));
  });

thread
  .command("assign <threadId>")
  .description("Assign a thread to a user")
  .requiredOption("--to <userId>", "assignee user id")
  .option("--idempotency-key <key>", "idempotency key")
  .action(async (threadId: string, opts: { to: string; idempotencyKey?: string }) => {
    const m = await client().applyCommand({
      type: "thread:assign",
      payload: { threadId, assigneeId: opts.to },
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    });
    emit(ok(m));
  });

thread
  .command("set-status <threadId>")
  .description("Set thread status")
  .requiredOption("--status <s>", "open|snoozed|resolved|archived")
  .option("--idempotency-key <key>", "idempotency key")
  .action(
    async (threadId: string, opts: { status: string; idempotencyKey?: string }) => {
      const m = await client().applyCommand({
        type: "thread:set-status",
        payload: { threadId, status: opts.status },
        ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      });
      emit(ok(m));
    },
  );

thread
  .command("tag <threadId>")
  .description("Add or remove tags on a thread")
  .option("--add <tag...>", "tags to add (repeatable)")
  .option("--remove <tag...>", "tags to remove (repeatable)")
  .option("--idempotency-key <key>", "idempotency key")
  .action(
    async (
      threadId: string,
      opts: { add?: string[]; remove?: string[]; idempotencyKey?: string },
    ) => {
      const adds = opts.add ?? [];
      const rems = opts.remove ?? [];
      if (adds.length === 0 && rems.length === 0) {
        throw new MailaiError("validation_error", "specify at least one --add or --remove tag");
      }
      const results: ReturnType<typeof shapeMutation>[] = [];
      for (const t of adds) {
        const m = await client().applyCommand({
          type: "thread:add-tag",
          payload: { threadId, tag: t },
          ...(opts.idempotencyKey ? { idempotencyKey: `${opts.idempotencyKey}:add:${t}` } : {}),
        });
        results.push(shapeMutation(m));
      }
      for (const t of rems) {
        const m = await client().applyCommand({
          type: "thread:remove-tag",
          payload: { threadId, tag: t },
          ...(opts.idempotencyKey ? { idempotencyKey: `${opts.idempotencyKey}:rem:${t}` } : {}),
        });
        results.push(shapeMutation(m));
      }
      emit({ ok: true, mutations: results });
    },
  );

// ------------------------------------------------------------ MESSAGES

const message = program.command("message").description("Read individual messages");

message
  .command("show <messageId>")
  .description("Show a single message")
  .option("--with-headers", "include full headers (when available)", false)
  .option("--with-body", "include body (when available)", false)
  .action(async (messageId: string, _opts: { withHeaders?: boolean; withBody?: boolean }) => {
    // The server side decides what it can return; we don't paramterize
    // the URL on these flags yet because the OAuth-message store keeps
    // metadata only. Once IMAP body fetch lands they'll matter.
    emit(await client().getMessage(messageId));
  });

// -------------------------------------------------------------- SEARCH

program
  .command("search <query>")
  .description("Full-text search across synced mail (Postgres tsvector)")
  .option("--limit <n>", "max hits", "50")
  .action(async (query: string, opts: { limit: string }) => {
    const items = await client().search(query, { limit: Number(opts.limit) || 50 });
    emit({ items, count: items.length });
  });

// ------------------------------------------------------------- INBOXES

const inbox = program.command("inbox").description("Shared inbox management");

inbox
  .command("list")
  .description("List shared inboxes")
  .action(async () => {
    const items = await client().listInboxes();
    emit({ items, count: items.length });
  });

inbox
  .command("show <id>")
  .description("Show one inbox with members + mailbox sources")
  .action(async (id: string) => {
    emit(await client().getInbox(id));
  });

inbox
  .command("create")
  .description("Create a new shared inbox")
  .requiredOption("--name <name>", "inbox name")
  .option("--description <text>", "human description")
  .action(async (opts: { name: string; description?: string }) => {
    const created = await client().createInbox({
      name: opts.name,
      ...(opts.description ? { description: opts.description } : {}),
    });
    emit({ ok: true, inbox: created });
  });

inbox
  .command("delete <id>")
  .description("Delete a shared inbox (cascades to members + mailboxes)")
  .action(async (id: string) => {
    await client().deleteInbox(id);
    emit({ ok: true, id });
  });

inbox
  .command("add-member <id>")
  .description("Add a member to an inbox")
  .requiredOption("--user <userId>", "user id")
  .requiredOption("--role <role>", "inbox-admin|agent|viewer")
  .action(async (id: string, opts: { user: string; role: string }) => {
    if (opts.role !== "inbox-admin" && opts.role !== "agent" && opts.role !== "viewer") {
      throw new MailaiError("validation_error", "--role must be inbox-admin|agent|viewer");
    }
    await client().addInboxMember(id, opts.user, opts.role);
    emit({ ok: true, id, userId: opts.user, role: opts.role });
  });

inbox
  .command("remove-member <id>")
  .description("Remove a member from an inbox")
  .requiredOption("--user <userId>", "user id")
  .action(async (id: string, opts: { user: string }) => {
    await client().removeInboxMember(id, opts.user);
    emit({ ok: true, id, userId: opts.user });
  });

// ---------------------------------------------------------------- AUDIT

const audit = program.command("audit").description("Read the durable audit log");

audit
  .command("list")
  .description("List audit entries (newest first)")
  .option("--actor <id>", "filter by actor id")
  .option("--type <t>", "filter by command type, e.g. mail:reply")
  .option("--thread <id>", "filter by payload threadId")
  .option("--since <when>", "ISO timestamp or relative (1h, 24h, 7d)")
  .option("--until <when>", "ISO timestamp or relative")
  .option("--cursor <c>", "pagination cursor (from previous nextCursor)")
  .option("--limit <n>", "max items per page", "50")
  .action(
    async (opts: {
      actor?: string;
      type?: string;
      thread?: string;
      since?: string;
      until?: string;
      cursor?: string;
      limit: string;
    }) => {
      const page = await client().listAudit({
        ...(opts.actor ? { actor: opts.actor } : {}),
        ...(opts.type ? { type: opts.type } : {}),
        ...(opts.thread ? { threadId: opts.thread } : {}),
        ...(opts.since ? { since: opts.since } : {}),
        ...(opts.until ? { until: opts.until } : {}),
        ...(opts.cursor ? { cursor: opts.cursor } : {}),
        limit: Number(opts.limit) || 50,
      });
      emit({ items: page.items, count: page.items.length, nextCursor: page.nextCursor });
    },
  );

// -------------------------------------------------------------- COMMENT

const comment = program.command("comment").description("Internal comments (overlay-only, never sent over IMAP)");

comment
  .command("add <threadId>")
  .description("Add an internal comment to a thread")
  .requiredOption("--text <text>", "comment body")
  .option("--mention <user...>", "mention user ids")
  .option("--idempotency-key <key>", "idempotency key")
  .action(
    async (
      threadId: string,
      opts: { text: string; mention?: string[]; idempotencyKey?: string },
    ) => {
      const m = await client().applyCommand({
        type: "comment:add",
        payload: { threadId, text: opts.text, mentions: opts.mention },
        ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      });
      emit(ok(m));
    },
  );

// ----------------------------------------------------------- SEND/REPLY

program
  .command("send")
  .description("Compose and send a new message")
  .requiredOption("--to <addr...>", "recipient(s)")
  .option("--cc <addr...>", "cc recipient(s)")
  .option("--bcc <addr...>", "bcc recipient(s)")
  .requiredOption("--subject <s>", "subject line")
  .option("--body <text>", "body text (or use --body-file / stdin)")
  .option("--body-file <path>", "read body from file")
  .option("--account <id>", "account id to send from (defaults to first connected)")
  .option("--idempotency-key <key>", "idempotency key (recommended for send)")
  .action(
    async (opts: {
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      body?: string;
      bodyFile?: string;
      account?: string;
      idempotencyKey?: string;
    }) => {
      const body = await resolveBody(opts);
      const m = await client().applyCommand({
        type: "mail:send",
        payload: {
          to: opts.to,
          ...(opts.cc ? { cc: opts.cc } : {}),
          ...(opts.bcc ? { bcc: opts.bcc } : {}),
          subject: opts.subject,
          body,
          ...(opts.account ? { accountId: opts.account } : {}),
        },
        ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      });
      emit(ok(m));
    },
  );

program
  .command("reply <threadId>")
  .description("Reply to a thread")
  .option("--body <text>", "reply text (or use --body-file / stdin)")
  .option("--body-file <path>", "read reply body from file")
  .option("--account <id>", "account id to send from")
  .option("--idempotency-key <key>", "idempotency key (recommended)")
  .action(
    async (
      threadId: string,
      opts: {
        body?: string;
        bodyFile?: string;
        account?: string;
        idempotencyKey?: string;
      },
    ) => {
      const body = await resolveBody(opts);
      const m = await client().applyCommand({
        type: "mail:reply",
        payload: {
          threadId,
          body,
          ...(opts.account ? { accountId: opts.account } : {}),
        },
        ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      });
      emit(ok(m));
    },
  );

// ---------------------------------------------------------------- WATCH

program
  .command("watch")
  .description("Subscribe to the realtime event stream and react to events")
  .option("--event <kind>", "filter by event kind (e.g. mutation, presence)")
  .option(
    "--exec <cmd>",
    "shell command to run for each event; {{json}} expands to the event JSON, {{thread_id}} to mutation.command.payload.threadId when present",
  )
  .action(async (opts: { event?: string; exec?: string }) => {
    const g = program.opts<Globals>();
    const wsUrl = process.env["MAILAI_WS_URL"] ?? deriveWsUrl(g.apiUrl);
    // Lazy-load to avoid pulling 'ws' into command paths that don't use it.
    const { default: WebSocket } = await import("ws");
    const ws = new WebSocket(wsUrl);
    ws.on("open", () => {
      process.stderr.write(`watching ${wsUrl}\n`);
    });
    ws.on("message", (raw: Buffer) => {
      const text = raw.toString("utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        process.stderr.write(`(non-json frame: ${text.slice(0, 80)}…)\n`);
        return;
      }
      const ev = parsed as { kind?: string };
      if (opts.event && ev.kind !== opts.event) return;
      process.stdout.write(JSON.stringify(parsed) + "\n");
      if (opts.exec) {
        void runExec(opts.exec, parsed);
      }
    });
    ws.on("close", () => process.exit(0));
    ws.on("error", (err: Error) => {
      process.stderr.write(`watch error: ${err.message}\n`);
      process.exit(3);
    });
  });

// ----------------------------------------------------------------- MCP

program
  .command("mcp")
  .description("Start the Model Context Protocol stdio server (advanced)")
  .action(async () => {
    await startMcpStdio();
  });

// --------------------------------------------------------------- HELPERS

async function resolveBody(opts: {
  body?: string;
  bodyFile?: string;
}): Promise<string> {
  if (opts.body !== undefined) return opts.body;
  if (opts.bodyFile) return readFile(opts.bodyFile, "utf8");
  // Fall through to stdin if it isn't a TTY (so `cat draft.md | mail-agent send ...`
  // works the way users expect).
  if (!process.stdin.isTTY) return readStdin();
  throw new MailaiError("validation_error", "missing --body, --body-file, or piped stdin");
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (buf += chunk));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

async function runExec(template: string, event: unknown): Promise<void> {
  const ev = event as { mutation?: { command?: { payload?: { threadId?: string } } } };
  const threadId = ev.mutation?.command?.payload?.threadId ?? "";
  const cmd = template
    .replaceAll("{{thread_id}}", shellEscape(threadId))
    .replaceAll("{{json}}", shellEscape(JSON.stringify(event)));
  // We use spawn rather than exec so the user's shell rules (PATH,
  // aliases, builtins) apply. Errors go to stderr and don't kill the
  // watch loop — that would defeat the point of long-running watch.
  const { spawn } = await import("node:child_process");
  const child = spawn("sh", ["-c", cmd], { stdio: "inherit" });
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function deriveWebUrl(apiUrl: string): string {
  // Best guess for "the web UI on the same machine": API on :8200,
  // web on :3200 in our dev defaults. Override with MAILAI_WEB_URL.
  try {
    const u = new URL(apiUrl);
    if (u.port === "8200") u.port = "3200";
    return u.origin;
  } catch {
    return "http://localhost:3200";
  }
}

function deriveWsUrl(apiUrl: string): string {
  try {
    const u = new URL(apiUrl);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.port = process.env["MAILAI_RT_PORT"] ?? "1235";
    u.pathname = "/";
    return u.toString();
  } catch {
    return "ws://localhost:1235";
  }
}

function exitForError(err: unknown): never {
  const fmt = chosenFormat();
  if (isMailaiError(err)) {
    const code =
      err.code === "auth_error"
        ? 2
        : err.code === "network_error"
          ? 3
          : err.code === "conflict_error"
            ? 4
            : err.code === "validation_error" || err.code === "user_error" || err.code === "not_found"
              ? 1
              : 5;
    const payload = { ok: false, error: err.code, message: err.message };
    if (fmt === "json") {
      // Errors go to stdout (in addition to non-zero exit) so callers
      // that scrape stdout still get a structured error. That matches
      // hof-os' "first JSON object on stdout" parsing convention.
      process.stdout.write(JSON.stringify(payload) + "\n");
    } else {
      process.stderr.write(JSON.stringify(payload) + "\n");
    }
    process.exit(code);
  }
  const payload = { ok: false, error: "internal_error", message: String(err) };
  if (fmt === "json") {
    process.stdout.write(JSON.stringify(payload) + "\n");
  } else {
    process.stderr.write(JSON.stringify(payload) + "\n");
  }
  process.exit(5);
}

program.parseAsync().catch(exitForError);
