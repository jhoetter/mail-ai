// Dev entry point. Boots fastify + ws on the same Node process.
// Production deployment usually splits these onto separate replicas,
// but for v1 single-process is enough.

import { WebSocketServer } from "ws";
import { CommandBus } from "@mailai/core";
import { buildApp } from "./app.js";
import { EventBroadcaster } from "./events.js";

async function main() {
  const bus = new CommandBus();
  const broadcaster = new EventBroadcaster();
  const app = buildApp({
    bus,
    broadcaster,
    // Stub identity: production uses JWT. Wire up in Phase 5.
    identity: async () => ({ userId: "u_dev", tenantId: "t_dev" }),
  });

  const port = Number(process.env["API_PORT"] ?? process.env["PORT"] ?? 8200);
  const wsPort = Number(process.env["MAILAI_RT_PORT"] ?? 1235);

  await app.listen({ host: "0.0.0.0", port });
  const wss = new WebSocketServer({ port: wsPort });
  broadcaster.attach(wss);
  app.log.info({ port, wsPort }, "mail-ai server listening");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
