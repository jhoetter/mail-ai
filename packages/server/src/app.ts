// Fastify app factory. The HTTP + WebSocket surface for mail-ai.
// All mutations route through the CommandBus instance the caller
// supplies — this file owns ZERO domain logic.

import Fastify, { type FastifyInstance } from "fastify";
import { CommandBus, type Command } from "@mailai/core";
import { CommandPayloadSchema } from "@mailai/agent";
import { EventBroadcaster } from "./events.js";

export interface AppDeps {
  readonly bus: CommandBus;
  readonly broadcaster: EventBroadcaster;
  readonly identity: (req: { headers: Record<string, unknown> }) => Promise<{
    userId: string;
    tenantId: string;
  }>;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: true });

  app.post("/api/commands", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const body = req.body as { commands: unknown[] } | unknown;
    const list = Array.isArray((body as { commands?: unknown[] }).commands)
      ? (body as { commands: unknown[] }).commands
      : [body];
    const headers = req.headers as Record<string, string | undefined>;
    const idempotencyKey = headers["idempotency-key"];
    const inboxId = headers["x-inbox-id"];
    const results = [];
    for (const raw of list) {
      const v = CommandPayloadSchema.safeParse(raw);
      if (!v.success) {
        return reply.code(400).send({ error: "validation_error", details: v.error.format() });
      }
      const source: Command["source"] = (headers["x-mailai-source"] as Command["source"]) ?? "human";
      const cmd: Command = {
        type: v.data.type,
        payload: v.data.payload,
        source,
        actorId: ident.userId,
        timestamp: Date.now(),
        sessionId: headers["x-session-id"] ?? crypto.randomUUID(),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      };
      const m = await deps.bus.dispatch(cmd, inboxId ? { inboxId } : {});
      results.push(m);
      deps.broadcaster.publish({ kind: "mutation", mutation: m });
    }
    return { results };
  });

  app.get("/api/mutations/pending", async (req) => {
    const headers = req.headers as Record<string, string | undefined>;
    const filter: { actorId?: string; type?: `${string}:${string}` } = {};
    const q = req.query as { actorId?: string; type?: string };
    if (q?.actorId) filter.actorId = q.actorId;
    if (q?.type) filter.type = q.type as `${string}:${string}`;
    void headers;
    return deps.bus.listPending(filter);
  });

  app.post("/api/mutations/:id/approve", async (req) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const { id } = req.params as { id: string };
    const m = await deps.bus.approve(id, ident.userId);
    deps.broadcaster.publish({ kind: "mutation", mutation: m });
    return m;
  });

  app.post("/api/mutations/:id/reject", async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body as { reason?: string } | undefined) ?? {};
    const m = body.reason !== undefined ? await deps.bus.reject(id, body.reason) : await deps.bus.reject(id);
    deps.broadcaster.publish({ kind: "mutation", mutation: m });
    return m;
  });

  app.get("/api/whoami", async (req) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    return { userId: ident.userId, tenantId: ident.tenantId, displayName: "" };
  });

  app.get("/api/health", async () => ({ ok: true }));

  return app;
}
