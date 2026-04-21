#!/usr/bin/env node
// mail-agent CLI. Pipeable, scriptable, JSON-by-default.
//
// Exit codes (per spec/agent/cli.md):
//   0 success, 1 validation/user, 2 auth, 3 network, 4 conflict,
//   5 internal.

import { Command as Cli } from "commander";
import { isMailaiError, MailaiError, type Mutation } from "@mailai/core";
import { HttpAgentClient } from "./http-client.js";
import { startMcpStdio } from "./mcp.js";
import { runDeviceFlow } from "./oauth-device.js";

interface Globals {
  format: "json" | "table" | "markdown";
  apiUrl: string;
  token: string;
}

const program = new Cli();
program
  .name("mail-agent")
  .description("mail-ai headless agent CLI")
  .version("0.0.0")
  .option("--format <fmt>", "json|table|markdown", "json")
  .option("--api-url <url>", "mail-ai HTTP API base URL", process.env["MAILAI_API_URL"] ?? "http://127.0.0.1:8080")
  .option("--token <token>", "Bearer token", process.env["MAILAI_TOKEN"] ?? "");

function client(): HttpAgentClient {
  const g = program.opts<Globals>();
  if (!g.token) throw new MailaiError("auth_error", "missing --token / MAILAI_TOKEN");
  return new HttpAgentClient({ baseUrl: g.apiUrl, token: g.token });
}

function emit(payload: unknown): void {
  const g = program.opts<Globals>();
  if (g.format === "json") {
    process.stdout.write(JSON.stringify(payload) + "\n");
    return;
  }
  if (g.format === "markdown") {
    process.stdout.write("```json\n" + JSON.stringify(payload, null, 2) + "\n```\n");
    return;
  }
  process.stdout.write(formatTable(payload) + "\n");
}

function formatTable(payload: unknown): string {
  if (Array.isArray(payload)) {
    if (payload.length === 0) return "(empty)";
    const cols = Object.keys(payload[0] as object);
    const header = cols.join("\t");
    const rows = payload.map((r) => cols.map((c) => String((r as Record<string, unknown>)[c] ?? "")).join("\t"));
    return [header, ...rows].join("\n");
  }
  return JSON.stringify(payload, null, 2);
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

program
  .command("auth login")
  .description("Authenticate via OAuth2 RFC 8628 device-code flow")
  .requiredOption("--provider <provider>", "google|microsoft|generic")
  .requiredOption("--client-id <id>", "OAuth client id")
  .requiredOption("--device-endpoint <url>")
  .requiredOption("--token-endpoint <url>")
  .option("--scope <scope>", "OAuth scope", "openid email offline_access")
  .action(async (opts: { provider: string; clientId: string; deviceEndpoint: string; tokenEndpoint: string; scope: string }) => {
    const result = await runDeviceFlow(
      {
        deviceAuthEndpoint: opts.deviceEndpoint,
        tokenEndpoint: opts.tokenEndpoint,
        clientId: opts.clientId,
        scope: opts.scope,
      },
      (code) => {
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
  });

program
  .command("auth whoami")
  .description("Print the authenticated identity as JSON")
  .action(async () => {
    emit(await client().whoami());
  });

program
  .command("apply <type>")
  .description("Apply an arbitrary command (payload from --payload-json or stdin)")
  .option("--payload-json <json>", "JSON payload literal")
  .option("--inbox <id>", "inbox id for staging policy")
  .option("--idempotency-key <key>", "idempotency key")
  .action(async (type: string, opts: { payloadJson?: string; inbox?: string; idempotencyKey?: string }) => {
    const raw = opts.payloadJson ?? (await readStdin());
    const payload = JSON.parse(raw);
    const m = await client().applyCommand({
      type: type as `${string}:${string}`,
      payload,
      ...(opts.inbox ? { inboxId: opts.inbox } : {}),
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    });
    emit(ok(m));
  });

program
  .command("thread assign <threadId>")
  .requiredOption("--to <userId>", "assignee user id")
  .action(async (threadId: string, opts: { to: string }) => {
    const m = await client().applyCommand({
      type: "thread:assign",
      payload: { threadId, assigneeId: opts.to },
    });
    emit(ok(m));
  });

program
  .command("thread set-status <threadId>")
  .requiredOption("--status <s>", "open|snoozed|resolved|archived")
  .action(async (threadId: string, opts: { status: string }) => {
    const m = await client().applyCommand({
      type: "thread:set-status",
      payload: { threadId, status: opts.status },
    });
    emit(ok(m));
  });

program
  .command("comment add <threadId>")
  .requiredOption("--text <text>", "comment body")
  .option("--mention <user...>", "mention user ids")
  .action(async (threadId: string, opts: { text: string; mention?: string[] }) => {
    const m = await client().applyCommand({
      type: "comment:add",
      payload: { threadId, text: opts.text, mentions: opts.mention },
    });
    emit(ok(m));
  });

program
  .command("pending list")
  .description("List staged agent mutations awaiting approval")
  .option("--type <t>", "filter by command type")
  .option("--actor <id>", "filter by actor id")
  .action(async (opts: { type?: string; actor?: string }) => {
    const filter: { actorId?: string; type?: `${string}:${string}` } = {};
    if (opts.actor) filter.actorId = opts.actor;
    if (opts.type) filter.type = opts.type as `${string}:${string}`;
    const items = await client().listPending(filter);
    emit({ items: items.map(shapeMutation), count: items.length });
  });

program
  .command("pending approve <id>")
  .action(async (id: string) => {
    const m = await client().approve(id);
    emit(ok(m));
  });

program
  .command("pending reject <id>")
  .option("--reason <text>")
  .action(async (id: string, opts: { reason?: string }) => {
    const m = await client().reject(id, opts.reason);
    emit(ok(m));
  });

program
  .command("mcp")
  .description("Start the Model Context Protocol stdio server")
  .action(async () => {
    await startMcpStdio();
  });

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (buf += chunk));
    process.stdin.on("end", () => resolve(buf || "{}"));
    process.stdin.on("error", reject);
  });
}

function exitForError(err: unknown): never {
  if (isMailaiError(err)) {
    const code =
      err.code === "auth_error"
        ? 2
        : err.code === "network_error"
          ? 3
          : err.code === "conflict_error"
            ? 4
            : err.code === "validation_error"
              ? 1
              : 5;
    process.stderr.write(JSON.stringify({ error: err.code, message: err.message }) + "\n");
    process.exit(code);
  }
  process.stderr.write(JSON.stringify({ error: "internal_error", message: String(err) }) + "\n");
  process.exit(5);
}

program.parseAsync().catch(exitForError);
